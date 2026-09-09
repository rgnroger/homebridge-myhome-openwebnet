import { OpenWebNetClient } from './openwebnet.js';
const PLUGIN_NAME = 'homebridge-myhome-openwebnet';
const PLATFORM_NAME = 'MyHomeOpenWebNet';
const LIGHTS = [
    {
        name: 'Luz 01',
        where: '01',
    },
    {
        name: 'Luz 41',
        where: '41',
    },
];
class MyHomeOpenWebNetPlatform {
    log;
    config;
    api;
    accessories = [];
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.log.info('MyHome OpenWebNet plugin iniciado.');
        this.api.on('didFinishLaunching', () => {
            this.discoverLights();
        });
    }
    configureAccessory(accessory) {
        this.log.info('Acessório carregado do cache: %s', accessory.displayName);
        this.accessories.push(accessory);
    }
    discoverLights() {
        for (const light of LIGHTS) {
            const uuid = this.api.hap.uuid.generate(`myhome-openwebnet-light-${light.where}`);
            let accessory = this.accessories.find((existingAccessory) => existingAccessory.UUID === uuid);
            if (!accessory) {
                accessory = new this.api.platformAccessory(light.name, uuid);
                accessory.context.where = light.where;
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                this.log.info('Novo acessório criado: %s (%s)', light.name, light.where);
            }
            else {
                this.log.info('Acessório existente restaurado: %s (%s)', light.name, light.where);
            }
            this.configureLightAccessory(accessory, light);
        }
    }
    configureLightAccessory(accessory, light) {
        accessory.context.where = light.where;
        const service = accessory.getService(this.api.hap.Service.Lightbulb) ??
            accessory.addService(this.api.hap.Service.Lightbulb, light.name);
        service.setCharacteristic(this.api.hap.Characteristic.Name, light.name);
        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .onSet(async (value) => {
            const on = Boolean(value);
            this.log.info('%s: comando %s', light.name, on ? 'ON' : 'OFF');
            try {
                await this.sendLightCommand(light.where, on);
                accessory.context.on = on;
            }
            catch (error) {
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                this.log.error('%s: erro ao enviar comando: %s', light.name, message);
                throw error;
            }
        });
        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .onGet(() => {
            return Boolean(accessory.context.on ?? false);
        });
    }
    async sendLightCommand(where, on) {
        const host = this.config.host;
        const port = Number(this.config.port ?? 20000);
        if (!host) {
            throw new Error('IP do gateway OpenWebNet não configurado.');
        }
        const client = new OpenWebNetClient({
            host,
            port,
        }, (message) => this.log.info(message));
        try {
            await client.connect();
            await client.openCommandSession();
            await client.setLight(where, on);
        }
        finally {
            client.disconnect();
        }
    }
}
export default (api) => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MyHomeOpenWebNetPlatform);
};
