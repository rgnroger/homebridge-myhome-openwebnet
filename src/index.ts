import {
  API,
  APIEvent,
  CharacteristicValue,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { OpenWebNetClient } from './openwebnet.js';

const PLUGIN_NAME = 'homebridge-myhome-openwebnet';
const PLATFORM_NAME = 'MyHomeOpenWebNet';

interface MyHomeLight {
  name: string;
  where: string;
}

interface ConfiguredLight {
  name?: unknown;
  bus?: unknown;
  area?: unknown;
  point?: unknown;
}

class MyHomeOpenWebNetPlatform implements DynamicPlatformPlugin {
  private readonly accessories: PlatformAccessory[] = [];
  private readonly accessoriesByWhere = new Map<string, PlatformAccessory>();
  private readonly states = new Map<string, boolean>();
  private readonly lights: MyHomeLight[];
  private client?: OpenWebNetClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.lights = this.readConfiguredLights();

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.discoverLights();
      this.startOpenWebNet();
    });

    this.api.on(APIEvent.SHUTDOWN, () => {
      this.client?.stop();
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  private discoverLights(): void {
    const configuredUuids = new Set<string>();

    for (const light of this.lights) {
      const uuid = this.api.hap.uuid.generate(
        `myhome-openwebnet-light-${light.where}`,
      );
      configuredUuids.add(uuid);

      let accessory = this.accessories.find(
        (cachedAccessory) => cachedAccessory.UUID === uuid,
      );

      if (!accessory) {
        accessory = new this.api.platformAccessory(light.name, uuid);

        this.api.registerPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          [accessory],
        );
      }

      accessory.context.where = light.where;
      accessory.context.on = Boolean(accessory.context.on ?? false);

      this.accessoriesByWhere.set(light.where, accessory);
      this.states.set(light.where, accessory.context.on as boolean);
      this.configureLightAccessory(accessory, light);
    }

    const staleAccessories = this.accessories.filter(
      (accessory) => !configuredUuids.has(accessory.UUID),
    );

    if (staleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        staleAccessories,
      );
    }

    this.log.info(
      '%d %s configurada%s.',
      this.lights.length,
      this.lights.length === 1 ? 'luz' : 'luzes',
      this.lights.length === 1 ? '' : 's',
    );
  }

  private configureLightAccessory(
    accessory: PlatformAccessory,
    light: MyHomeLight,
  ): void {
    const service =
      accessory.getService(this.api.hap.Service.Lightbulb) ??
      accessory.addService(this.api.hap.Service.Lightbulb, light.name);

    service.setCharacteristic(
      this.api.hap.Characteristic.Name,
      light.name,
    );

    service
      .getCharacteristic(this.api.hap.Characteristic.On)
      .on('get', (callback) => {
        callback(null, this.states.get(light.where) ?? false);
      })
      .on('set', (value: CharacteristicValue, callback) => {
        const on = Boolean(value);

        this.states.set(light.where, on);
        accessory.context.on = on;

        this.sendLightCommand(light, on);
        callback(null);
      });
  }

  private startOpenWebNet(): void {
    const host = typeof this.config.host === 'string'
      ? this.config.host.trim()
      : '';
    const port = Number(this.config.port ?? 20000);

    if (!host) {
      this.log.error('IP do gateway OpenWebNet não configurado.');
      return;
    }

    if (this.lights.length === 0) {
      this.log.warn('Nenhuma luz foi configurada.');
      return;
    }

    this.client = new OpenWebNetClient(
      {
        host,
        port,
        monitoredLights: this.lights.map((light) => light.where),
      },
      (message) => this.log.info(message),
      {
        onLightState: (where, on) => this.updateLightState(where, on),
      },
    );

    void this.client.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('Não foi possível iniciar o OpenWebNet: %s', message);
    });
  }

  private sendLightCommand(light: MyHomeLight, on: boolean): void {
    if (!this.client) {
      this.log.error(
        '%s: OpenWebNet ainda não foi iniciado.',
        light.name,
      );
      return;
    }

    this.client.setLight(light.where, on);
  }

  private updateLightState(where: string, on: boolean): void {
    const accessory = this.accessoriesByWhere.get(where);
    if (!accessory) {
      return;
    }

    this.states.set(where, on);
    accessory.context.on = on;

    const characteristic = accessory
      .getService(this.api.hap.Service.Lightbulb)
      ?.getCharacteristic(this.api.hap.Characteristic.On);

    // Mesmo ciclo usado pelo fork funcional para Homebridge 2:
    // o evento do BUS muda o estado e força a característica a relê-lo.
    if (characteristic) {
      const legacyCharacteristic = characteristic as unknown as {
        emit: (event: 'get', callback: () => void) => boolean;
      };
      legacyCharacteristic.emit('get', () => undefined);
    }

  }

  private readConfiguredLights(): MyHomeLight[] {
    if (!Array.isArray(this.config.lights)) {
      return [];
    }

    const lights: MyHomeLight[] = [];
    const usedAddresses = new Set<string>();

    for (const rawLight of this.config.lights as ConfiguredLight[]) {
      const name = typeof rawLight.name === 'string'
        ? rawLight.name.trim()
        : '';
      const bus = this.readAddressPart(rawLight.bus, 0);
      const area = this.readAddressPart(rawLight.area);
      const point = this.readAddressPart(rawLight.point);

      if (!name || bus === undefined || area === undefined || point === undefined) {
        this.log.warn('Uma luz foi ignorada porque sua configuração está incompleta.');
        continue;
      }

      const where = this.toOpenWebNetAddress(bus, area, point);
      if (usedAddresses.has(where)) {
        this.log.warn('A luz %s foi ignorada porque o endereço está repetido.', name);
        continue;
      }

      usedAddresses.add(where);
      lights.push({ name, where });
    }

    return lights;
  }

  private readAddressPart(value: unknown, defaultValue?: number): number | undefined {
    if ((value === undefined || value === null || value === '') && defaultValue !== undefined) {
      return defaultValue;
    }

    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 99) {
      return undefined;
    }

    return number;
  }

  private toOpenWebNetAddress(bus: number, area: number, point: number): string {
    const address = area >= 10 || point >= 10
      ? `${String(area).padStart(2, '0')}${String(point).padStart(2, '0')}`
      : `${area}${point}`;

    return bus === 0
      ? address
      : `${address}#4#${String(bus).padStart(2, '0')}`;
  }
}

export default (api: API): void => {
  api.registerPlatform(
    PLUGIN_NAME,
    PLATFORM_NAME,
    MyHomeOpenWebNetPlatform,
  );
};
