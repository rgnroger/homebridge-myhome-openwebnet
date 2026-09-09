import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

const PLUGIN_NAME = 'homebridge-myhome-openwebnet';
const PLATFORM_NAME = 'MyHomeOpenWebNet';

class MyHomeOpenWebNetPlatform implements DynamicPlatformPlugin {

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('MyHome OpenWebNet plugin iniciado.');
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(
      'Acessório carregado do cache: %s',
      accessory.displayName,
    );
  }
}

export default (api: API): void => {
  api.registerPlatform(
    PLUGIN_NAME,
    PLATFORM_NAME,
    MyHomeOpenWebNetPlatform,
  );
};