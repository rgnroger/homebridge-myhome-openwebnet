import { OpenWebNetClient } from './openwebnet.js';
const PLUGIN_NAME = 'homebridge-myhome-openwebnet';
const PLATFORM_NAME = 'MyHomeOpenWebNet';
class MyHomeOpenWebNetPlatform {
    log;
    config;
    api;
    accessories = [];
    accessoriesByWhere = new Map();
    dimmerAccessoriesByWhere = new Map();
    states = new Map();
    brightnessStates = new Map();
    lights;
    dimmers;
    client;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        const usedAddresses = new Set();
        this.lights = this.readConfiguredDevices('lights', 'luz', usedAddresses);
        this.dimmers = this.readConfiguredDevices('dimmers', 'dimmer', usedAddresses);
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
        const configuredUuids = new Set();
        for (const light of this.lights) {
            const uuid = this.api.hap.uuid.generate(`myhome-openwebnet-light-${light.where}`);
            configuredUuids.add(uuid);
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
        for (const dimmer of this.dimmers) {
            const uuid = this.api.hap.uuid.generate(`myhome-openwebnet-dimmer-${dimmer.where}`);
            configuredUuids.add(uuid);
            let accessory = this.accessories.find((cachedAccessory) => cachedAccessory.UUID === uuid);
            if (!accessory) {
                accessory = new this.api.platformAccessory(dimmer.name, uuid);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
            accessory.context.where = dimmer.where;
            accessory.context.on = Boolean(accessory.context.on ?? false);
            accessory.context.brightness = Number(accessory.context.brightness ?? 100);
            this.dimmerAccessoriesByWhere.set(dimmer.where, accessory);
            this.states.set(dimmer.where, accessory.context.on);
            this.brightnessStates.set(dimmer.where, accessory.context.brightness);
            this.configureDimmerAccessory(accessory, dimmer);
        }
        const staleAccessories = this.accessories.filter((accessory) => !configuredUuids.has(accessory.UUID));
        if (staleAccessories.length > 0) {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
        }
        this.log.info('%d luz(es) e %d dimmer(es) configurado(s).', this.lights.length, this.dimmers.length);
    }
    configureLightAccessory(accessory, light) {
        const service = accessory.getService(this.api.hap.Service.Lightbulb) ??
            accessory.addService(this.api.hap.Service.Lightbulb, light.name);
        service.setCharacteristic(this.api.hap.Characteristic.Name, light.name);
        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on('get', (callback) => {
            callback(null, this.states.get(light.where) ?? false);
        })
            .on('set', (value, callback) => {
            const on = Boolean(value);
            this.states.set(light.where, on);
            accessory.context.on = on;
            this.sendLightCommand(light, on);
            callback(null);
        });
    }
    configureDimmerAccessory(accessory, dimmer) {
        const service = accessory.getService(this.api.hap.Service.Lightbulb) ??
            accessory.addService(this.api.hap.Service.Lightbulb, dimmer.name);
        service.setCharacteristic(this.api.hap.Characteristic.Name, dimmer.name);
        service
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on('get', (callback) => {
            callback(null, this.states.get(dimmer.where) ?? false);
        })
            .on('set', (value, callback) => {
            const on = Boolean(value);
            this.states.set(dimmer.where, on);
            accessory.context.on = on;
            if (on && (this.brightnessStates.get(dimmer.where) ?? 0) === 0) {
                this.brightnessStates.set(dimmer.where, 100);
                accessory.context.brightness = 100;
            }
            this.sendLightCommand(dimmer, on);
            callback(null);
        });
        service
            .getCharacteristic(this.api.hap.Characteristic.Brightness)
            .on('get', (callback) => {
            callback(null, this.brightnessStates.get(dimmer.where) ?? 100);
        })
            .on('set', (value, callback) => {
            const brightness = Math.max(0, Math.min(100, Math.round(Number(value))));
            const on = brightness > 0;
            this.brightnessStates.set(dimmer.where, brightness);
            this.states.set(dimmer.where, on);
            accessory.context.brightness = brightness;
            accessory.context.on = on;
            this.client?.setDimmer(dimmer.where, brightness);
            callback(null);
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
        const lightingDevices = [...this.lights, ...this.dimmers];
        if (lightingDevices.length === 0) {
            this.log.warn('Nenhuma luz ou dimmer foi configurado.');
            return;
        }
        this.client = new OpenWebNetClient({
            host,
            port,
            monitoredLights: lightingDevices.map((device) => device.where),
        }, (message) => this.log.info(message), {
            onLightState: (where, on) => this.updateLightState(where, on),
            onDimmerState: (where, brightness) => {
                this.updateDimmerState(where, brightness);
            },
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
        this.client.setLight(light.where, on);
    }
    updateLightState(where, on) {
        const accessory = this.accessoriesByWhere.get(where) ??
            this.dimmerAccessoriesByWhere.get(where);
        if (!accessory) {
            return;
        }
        this.states.set(where, on);
        accessory.context.on = on;
        const service = accessory.getService(this.api.hap.Service.Lightbulb);
        const characteristic = service?.getCharacteristic(this.api.hap.Characteristic.On);
        if (this.dimmerAccessoriesByWhere.has(where)) {
            const brightness = on ? 100 : 0;
            this.brightnessStates.set(where, brightness);
            accessory.context.brightness = brightness;
            this.refreshCharacteristic(service?.getCharacteristic(this.api.hap.Characteristic.Brightness));
        }
        // Mesmo ciclo usado pelo fork funcional para Homebridge 2:
        // o evento do BUS muda o estado e força a característica a relê-lo.
        if (characteristic) {
            const legacyCharacteristic = characteristic;
            legacyCharacteristic.emit('get', () => undefined);
        }
    }
    updateDimmerState(where, brightness) {
        const accessory = this.dimmerAccessoriesByWhere.get(where);
        if (!accessory) {
            return;
        }
        const on = brightness > 0;
        this.brightnessStates.set(where, brightness);
        this.states.set(where, on);
        accessory.context.brightness = brightness;
        accessory.context.on = on;
        const service = accessory.getService(this.api.hap.Service.Lightbulb);
        this.refreshCharacteristic(service?.getCharacteristic(this.api.hap.Characteristic.Brightness));
        this.refreshCharacteristic(service?.getCharacteristic(this.api.hap.Characteristic.On));
    }
    readConfiguredDevices(configKey, deviceLabel, usedAddresses) {
        const configuredDevices = this.config[configKey];
        if (!Array.isArray(configuredDevices)) {
            return [];
        }
        const lights = [];
        for (const rawLight of configuredDevices) {
            const name = typeof rawLight.name === 'string'
                ? rawLight.name.trim()
                : '';
            const bus = this.readAddressPart(rawLight.bus, 0);
            const area = this.readAddressPart(rawLight.area);
            const point = this.readAddressPart(rawLight.point);
            if (!name || bus === undefined || area === undefined || point === undefined) {
                this.log.warn('Um %s foi ignorado porque sua configuração está incompleta.', deviceLabel);
                continue;
            }
            const where = this.toOpenWebNetAddress(bus, area, point);
            if (usedAddresses.has(where)) {
                this.log.warn('O dispositivo %s foi ignorado porque o endereço está repetido.', name);
                continue;
            }
            usedAddresses.add(where);
            lights.push({ name, where });
        }
        return lights;
    }
    refreshCharacteristic(characteristic) {
        if (!characteristic) {
            return;
        }
        const legacyCharacteristic = characteristic;
        legacyCharacteristic.emit('get', () => undefined);
    }
    readAddressPart(value, defaultValue) {
        if ((value === undefined || value === null || value === '') && defaultValue !== undefined) {
            return defaultValue;
        }
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0 || number > 99) {
            return undefined;
        }
        return number;
    }
    toOpenWebNetAddress(bus, area, point) {
        const address = area >= 10 || point >= 10
            ? `${String(area).padStart(2, '0')}${String(point).padStart(2, '0')}`
            : `${area}${point}`;
        return bus === 0
            ? address
            : `${address}#4#${String(bus).padStart(2, '0')}`;
    }
}
export default (api) => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MyHomeOpenWebNetPlatform);
};
