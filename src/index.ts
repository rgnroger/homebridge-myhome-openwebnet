import {
  API,
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
  {
    name: 'Luz 01',
    where: '01',
  },
  {
    name: 'Luz 41',
    where: '41',
  },
];

class MyHomeOpenWebNetPlatform implements DynamicPlatformPlugin {

  private readonly accessories: PlatformAccessory[] = [];

  private readonly states = new Map<string, boolean>();

  private readonly commandInProgress = new Set<string>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('MyHome OpenWebNet plugin iniciado.');

    this.api.on('didFinishLaunching', () => {
      this.discoverLights();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(
      'Acessório carregado do cache: %s',
      accessory.displayName,
    );

    this.accessories.push(accessory);
  }

  private discoverLights(): void {

    for (const light of LIGHTS) {

      const uuid = this.api.hap.uuid.generate(
        `myhome-openwebnet-light-${light.where}`,
      );

      let accessory = this.accessories.find(
        (existingAccessory) => existingAccessory.UUID === uuid,
      );

      if (!accessory) {

        accessory = new this.api.platformAccessory(
          light.name,
          uuid,
        );

        accessory.context.where = light.where;
        accessory.context.on = false;

        this.api.registerPlatformAccessories(
          PLUGIN_NAME,
          PLATFORM_NAME,
          [accessory],
        );

        this.log.info(
          'Novo acessório criado: %s (%s)',
          light.name,
          light.where,
        );

      } else {

        this.log.info(
          'Acessório existente restaurado: %s (%s)',
          light.name,
          light.where,
        );
      }

      const currentState =
        Boolean(accessory.context.on ?? false);

      this.states.set(
        light.where,
        currentState,
      );

      this.configureLightAccessory(
        accessory,
        light,
      );
    }
  }

  private configureLightAccessory(
    accessory: PlatformAccessory,
    light: MyHomeLight,
  ): void {

    const service =
      accessory.getService(this.api.hap.Service.Lightbulb) ??
      accessory.addService(
        this.api.hap.Service.Lightbulb,
        light.name,
      );

    service.setCharacteristic(
      this.api.hap.Characteristic.Name,
      light.name,
    );

    service
      .getCharacteristic(this.api.hap.Characteristic.On)
      .onGet(() => {
        return this.states.get(light.where) ?? false;
      })
      .onSet(async (value: CharacteristicValue) => {

        const requestedState = Boolean(value);

        const currentState =
          this.states.get(light.where);

        if (currentState === requestedState) {

          this.log.debug(
            '%s: estado já é %s. Ignorando comando repetido.',
            light.name,
            requestedState ? 'ON' : 'OFF',
          );

          return;
        }

        if (this.commandInProgress.has(light.where)) {

          this.log.debug(
            '%s: comando já em andamento. Ignorando repetição.',
            light.name,
          );

          return;
        }

        this.commandInProgress.add(light.where);

        this.log.info(
          '%s: enviando comando %s',
          light.name,
          requestedState ? 'ON' : 'OFF',
        );

        try {

          await this.sendLightCommand(
            light.where,
            requestedState,
          );

          this.states.set(
            light.where,
            requestedState,
          );

          accessory.context.on =
            requestedState;

          this.log.info(
            '%s: estado atualizado para %s',
            light.name,
            requestedState ? 'ON' : 'OFF',
          );

        } catch (error) {

          const message =
            error instanceof Error
              ? error.message
              : String(error);

          this.log.error(
            '%s: erro ao enviar comando: %s',
            light.name,
            message,
          );

          throw error;

        } finally {

          this.commandInProgress.delete(
            light.where,
          );
        }
      });
  }

  private async sendLightCommand(
    where: string,
    on: boolean,
  ): Promise<void> {

    const host = this.config.host as string;
    const port = Number(this.config.port ?? 20000);

    if (!host) {
      throw new Error(
        'IP do gateway OpenWebNet não configurado.',
      );
    }

    const client = new OpenWebNetClient(
      {
        host,
        port,
      },
      (message) => this.log.info(message),
    );

    try {

      await client.connect();

      await client.openCommandSession();

      await client.setLight(
        where,
        on,
      );

    } finally {

      client.disconnect();
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