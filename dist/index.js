import { OpenWebNetClient } from './openwebnet.js';
const PLUGIN_NAME = 'homebridge-myhome-openwebnet';
const PLATFORM_NAME = 'MyHomeOpenWebNet';
const LIGHTS = [
    { name: 'Luz 01', where: '01' },
    { name: 'Luz 41', where: '41' },
];
class MyHomeOpenWebNetPlatform {
    log;
    config;
    api;
    accessories = [];
    accessoriesByWhere = new Map();
    states = new Map();
    client;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.api.on("didFinishLaunching" /* APIEvent.DID_FINISH_LAUNCHING */, () => {
            this.discoverLights();
            this.startOpenWebNet();
        });
        this.api.on("shutdown" /* APIEvent.SHUTDOWN */, () => {
            this.client?.stop();
        });
    }
    configureAccessory(accessory) {
        this.accessories.push(accessory);
    }
    discoverLights() {
        for (const light of LIGHTS) {
            const uuid = this.api.hap.uuid.generate(`myhome-openwebnet-light-${light.where}`);
            let accessory = this.accessories.find((cachedAccessory) => cachedAccessory.UUID === uuid);
            if (!accessory) {
                accessory = new this.api.platformAccessory(light.name, uuid);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
            accessory.context.where = light.where;
            accessory.context.on = Boolean(accessory.context.on ?? false);
            this.accessoriesByWhere.set(light.where, accessory);
            this.states.set(light.where, accessory.context.on);
            this.configureLightAccessory(accessory, light);
        }
        this.log.info('Luzes 01 e 41 configuradas.');
    }
    configureLightAccessory(accessory, light) {
        const service = accessory.getService(this.api.hap.Service.Lightbulb) ??
            accessory.addService(this.api.hap.Service.Lightbulb, light.name);
        service.setCharacteristic(this.api.hap.Characteristic.Name, light.name);
        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .onGet(() => this.states.get(light.where) ?? false)
            .onSet((value) => {
            const on = Boolean(value);
            this.states.set(light.where, on);
            accessory.context.on = on;
            this.log.info('HomeKit solicitou Luz %s: %s.', light.where, on ? 'ON' : 'OFF');
            this.sendLightCommand(light, on);
        });
    }
    startOpenWebNet() {
        const host = typeof this.config.host === 'string'
            ? this.config.host.trim()
            : '';
        const port = Number(this.config.port ?? 20000);
        if (!host) {
            this.log.error('IP do gateway OpenWebNet não configurado.');
            return;
        }
        this.client = new OpenWebNetClient({
            host,
            port,
            monitoredLights: LIGHTS.map((light) => light.where),
        }, (message) => this.log.info(message), {
            onLightState: (where, on) => this.updateLightState(where, on),
        });
        void this.client.start().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.log.error('Não foi possível iniciar o OpenWebNet: %s', message);
        });
    }
    sendLightCommand(light, on) {
        if (!this.client) {
            this.log.error('%s: OpenWebNet ainda não foi iniciado.', light.name);
            return;
        }
        void this.client.setLight(light.where, on).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.log.error('%s: erro ao enviar comando (%s).', light.name, message);
        });
    }
    updateLightState(where, on) {
        const accessory = this.accessoriesByWhere.get(where);
        if (!accessory) {
            return;
        }
        const previousState = this.states.get(where);
        this.states.set(where, on);
        accessory.context.on = on;
        const service = accessory.getService(this.api.hap.Service.Lightbulb);
        service?.updateCharacteristic(this.api.hap.Characteristic.On, on);
        if (previousState !== on) {
            this.log.info('Luz %s confirmada pelo BUS como %s.', where, on ? 'ON' : 'OFF');
        }
    }
}
export default (api) => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MyHomeOpenWebNetPlatform);
};
