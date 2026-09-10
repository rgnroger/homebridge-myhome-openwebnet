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

const LIGHTS: MyHomeLight[] = [
  { name: 'Luz 1', where: '11' },
  { name: 'Luz 2', where: '12' },
];

class MyHomeOpenWebNetPlatform implements DynamicPlatformPlugin {
  private readonly accessories: PlatformAccessory[] = [];
  private readonly accessoriesByWhere = new Map<string, PlatformAccessory>();
  private readonly states = new Map<string, boolean>();
  private client?: OpenWebNetClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
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
    for (const light of LIGHTS) {
      const uuid = this.api.hap.uuid.generate(
        `myhome-openwebnet-light-${light.where}`,
      );

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

    this.log.info('Luzes 11 e 12 configuradas.');
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
      .onGet(() => this.states.get(light.where) ?? false)
      .onSet((value: CharacteristicValue) => {
        const on = Boolean(value);

        this.states.set(light.where, on);
        accessory.context.on = on;

        this.log.info(
          'HomeKit solicitou Luz %s: %s.',
          light.where,
          on ? 'ON' : 'OFF',
        );

        this.sendLightCommand(light, on);
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

    this.client = new OpenWebNetClient(
      {
        host,
        port,
        monitoredLights: LIGHTS.map((light) => light.where),
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

    void this.client.setLight(light.where, on).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(
        '%s: erro ao enviar comando (%s).',
        light.name,
        message,
      );
    });
  }

  private updateLightState(where: string, on: boolean): void {
    const accessory = this.accessoriesByWhere.get(where);
    if (!accessory) {
      return;
    }

    const previousState = this.states.get(where);

    this.states.set(where, on);
    accessory.context.on = on;

    const characteristic = accessory
      .getService(this.api.hap.Service.Lightbulb)
      ?.getCharacteristic(this.api.hap.Characteristic.On);

    characteristic?.sendEventNotification(on);

    if (previousState !== on) {
      this.log.info(
        'Luz %s confirmada pelo BUS como %s.',
        where,
        on ? 'ON' : 'OFF',
      );
    }
  }
}

export default (api: API): void => {
  api.registerPlatform(
    PLUGIN_NAME,
    PLATFORM_NAME,
    MyHomeOpenWebNetPlatform,
  );
};
