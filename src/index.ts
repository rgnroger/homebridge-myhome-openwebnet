import {
  API, APIEvent, CharacteristicValue, DynamicPlatformPlugin, Logger,
  PlatformAccessory, PlatformConfig,
} from 'homebridge';
import { OpenWebNetClient } from './openwebnet.js';

const PLUGIN_NAME = 'homebridge-myhome-openwebnet';
const PLATFORM_NAME = 'MyHomeOpenWebNet';

interface Device { name: string; where: string }
interface Blind extends Device { travelTime: number; invert: boolean }
interface RawDevice {
  name?: unknown; bus?: unknown; area?: unknown; point?: unknown;
  travelTime?: unknown; invert?: unknown;
}
interface BlindRuntime {
  current: number; target: number; direction: -1 | 0 | 1;
  startedAt: number; startedFrom: number; ignoreStopUntil: number;
  updateTimer?: NodeJS.Timeout; stopTimer?: NodeJS.Timeout;
}

class MyHomeOpenWebNetPlatform implements DynamicPlatformPlugin {
  private readonly accessories: PlatformAccessory[] = [];
  private readonly lightAccessories = new Map<string, PlatformAccessory>();
  private readonly dimmerAccessories = new Map<string, PlatformAccessory>();
  private readonly blindAccessories = new Map<string, PlatformAccessory>();
  private readonly advancedBlindAccessories = new Map<string, PlatformAccessory>();
  private readonly states = new Map<string, boolean>();
  private readonly brightnessStates = new Map<string, number>();
  private readonly blindRuntimes = new Map<string, BlindRuntime>();
  private readonly lights: Device[];
  private readonly dimmers: Device[];
  private readonly blinds: Blind[];
  private readonly advancedBlinds: Device[];
  private client?: OpenWebNetClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    const used = new Set<string>();
    this.lights = this.readDevices('lights', 'luz', used);
    this.dimmers = this.readDevices('dimmers', 'dimmer', used);
    this.blinds = this.readBlinds(used);
    this.advancedBlinds = this.readDevices('advancedBlinds', 'persiana avançada', used);

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.discoverDevices();
      this.startOpenWebNet();
    });
    this.api.on(APIEvent.SHUTDOWN, () => {
      for (const runtime of this.blindRuntimes.values()) this.clearBlindTimers(runtime);
      this.client?.stop();
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  private discoverDevices(): void {
    const configured = new Set<string>();

    for (const device of this.lights) {
      const accessory = this.findOrCreate(device, `light-${device.where}`, configured);
      accessory.context.on = Boolean(accessory.context.on ?? false);
      this.lightAccessories.set(device.where, accessory);
      this.states.set(device.where, accessory.context.on as boolean);
      this.configureLight(accessory, device);
    }
    for (const device of this.dimmers) {
      const accessory = this.findOrCreate(device, `dimmer-${device.where}`, configured);
      accessory.context.on = Boolean(accessory.context.on ?? false);
      accessory.context.brightness = Number(accessory.context.brightness ?? 100);
      this.dimmerAccessories.set(device.where, accessory);
      this.states.set(device.where, accessory.context.on as boolean);
      this.brightnessStates.set(device.where, accessory.context.brightness as number);
      this.configureDimmer(accessory, device);
    }
    for (const device of this.blinds) {
      const accessory = this.findOrCreate(device, `blind-${device.where}`, configured);
      this.blindAccessories.set(device.where, accessory);
      this.configureBlind(accessory, device);
    }
    for (const device of this.advancedBlinds) {
      const accessory = this.findOrCreate(device, `advanced-blind-${device.where}`, configured);
      this.advancedBlindAccessories.set(device.where, accessory);
      this.configureAdvancedBlind(accessory, device);
    }

    const stale = this.accessories.filter((accessory) => !configured.has(accessory.UUID));
    if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    this.log.info(
      '%d luz(es), %d dimmer(es) e %d persiana(s) configurado(s).',
      this.lights.length, this.dimmers.length, this.blinds.length + this.advancedBlinds.length,
    );
  }

  private findOrCreate(device: Device, suffix: string, configured: Set<string>): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(`myhome-openwebnet-${suffix}`);
    configured.add(uuid);
    let accessory = this.accessories.find((cached) => cached.UUID === uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(device.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    accessory.context.where = device.where;
    return accessory;
  }

  private configureLight(accessory: PlatformAccessory, device: Device): void {
    const service = accessory.getService(this.api.hap.Service.Lightbulb) ??
      accessory.addService(this.api.hap.Service.Lightbulb, device.name);
    service.setCharacteristic(this.api.hap.Characteristic.Name, device.name);
    service.getCharacteristic(this.api.hap.Characteristic.On)
      .on('get', (callback) => callback(null, this.states.get(device.where) ?? false))
      .on('set', (value: CharacteristicValue, callback) => {
        const on = Boolean(value);
        this.states.set(device.where, on);
        accessory.context.on = on;
        this.sendLight(device, on);
        callback(null);
      });
  }

  private configureDimmer(accessory: PlatformAccessory, device: Device): void {
    const service = accessory.getService(this.api.hap.Service.Lightbulb) ??
      accessory.addService(this.api.hap.Service.Lightbulb, device.name);
    service.setCharacteristic(this.api.hap.Characteristic.Name, device.name);
    service.getCharacteristic(this.api.hap.Characteristic.On)
      .on('get', (callback) => callback(null, this.states.get(device.where) ?? false))
      .on('set', (value: CharacteristicValue, callback) => {
        const on = Boolean(value);
        const brightness = on ? Math.max(1, this.brightnessStates.get(device.where) ?? 100) : 0;
        this.states.set(device.where, on);
        this.brightnessStates.set(device.where, brightness);
        accessory.context.on = on;
        accessory.context.brightness = brightness;
        service.getCharacteristic(this.api.hap.Characteristic.Brightness).updateValue(brightness);
        this.sendLight(device, on);
        callback(null);
      });
    service.getCharacteristic(this.api.hap.Characteristic.Brightness)
      .on('get', (callback) => callback(null, this.brightnessStates.get(device.where) ?? 100))
      .on('set', (value: CharacteristicValue, callback) => {
        const brightness = this.clamp(Number(value));
        const on = brightness > 0;
        this.brightnessStates.set(device.where, brightness);
        this.states.set(device.where, on);
        accessory.context.brightness = brightness;
        accessory.context.on = on;
        service.getCharacteristic(this.api.hap.Characteristic.On).updateValue(on);
        this.client?.setDimmer(device.where, brightness);
        callback(null);
      });
  }

  private configureBlind(accessory: PlatformAccessory, device: Blind): void {
    const service = accessory.getService(this.api.hap.Service.WindowCovering) ??
      accessory.addService(this.api.hap.Service.WindowCovering, device.name);
    service.setCharacteristic(this.api.hap.Characteristic.Name, device.name);
    this.createBlindRuntime(accessory, device.where);
    service.getCharacteristic(this.api.hap.Characteristic.CurrentPosition)
      .on('get', (callback) => callback(null, this.runtime(device.where).current));
    service.getCharacteristic(this.api.hap.Characteristic.TargetPosition)
      .on('get', (callback) => callback(null, this.runtime(device.where).target))
      .on('set', (value: CharacteristicValue, callback) => {
        this.moveBlindTo(accessory, device, this.clamp(Number(value)));
        callback(null);
      });
    service.getCharacteristic(this.api.hap.Characteristic.PositionState)
      .on('get', (callback) => callback(null, this.positionState(this.runtime(device.where).direction)));
  }

  private configureAdvancedBlind(accessory: PlatformAccessory, device: Device): void {
    const service = accessory.getService(this.api.hap.Service.WindowCovering) ??
      accessory.addService(this.api.hap.Service.WindowCovering, device.name);
    service.setCharacteristic(this.api.hap.Characteristic.Name, device.name);
    this.createBlindRuntime(accessory, device.where);
    service.getCharacteristic(this.api.hap.Characteristic.CurrentPosition)
      .on('get', (callback) => callback(null, this.runtime(device.where).current));
    service.getCharacteristic(this.api.hap.Characteristic.TargetPosition)
      .on('get', (callback) => callback(null, this.runtime(device.where).target))
      .on('set', (value: CharacteristicValue, callback) => {
        const runtime = this.runtime(device.where);
        runtime.target = this.clamp(Number(value));
        runtime.direction = runtime.target === runtime.current ? 0 : runtime.target > runtime.current ? 1 : -1;
        accessory.context.targetPosition = runtime.target;
        service.getCharacteristic(this.api.hap.Characteristic.PositionState)
          .updateValue(this.positionState(runtime.direction));
        this.client?.setAdvancedBlind(device.where, runtime.target);
        callback(null);
      });
    service.getCharacteristic(this.api.hap.Characteristic.PositionState)
      .on('get', (callback) => callback(null, this.positionState(this.runtime(device.where).direction)));
  }

  private createBlindRuntime(accessory: PlatformAccessory, where: string): void {
    const current = this.clamp(Number(accessory.context.currentPosition ?? 0));
    const target = this.clamp(Number(accessory.context.targetPosition ?? current));
    this.blindRuntimes.set(where, {
      current, target, direction: 0, startedAt: 0, startedFrom: current, ignoreStopUntil: 0,
    });
  }

  private startOpenWebNet(): void {
    const host = typeof this.config.host === 'string' ? this.config.host.trim() : '';
    const port = Number(this.config.port ?? 20000);
    if (!host) {
      this.log.error('IP do gateway OpenWebNet não configurado.');
      return;
    }
    const total = this.lights.length + this.dimmers.length + this.blinds.length + this.advancedBlinds.length;
    if (!total) {
      this.log.warn('Nenhum dispositivo foi configurado.');
      return;
    }
    this.client = new OpenWebNetClient({
      host, port,
      monitoredLights: [...this.lights, ...this.dimmers].map((device) => device.where),
      monitoredBlinds: this.blinds.map((device) => device.where),
      monitoredAdvancedBlinds: this.advancedBlinds.map((device) => device.where),
    }, (message) => this.log.info(message), {
      onLightState: (where, on) => this.updateLightState(where, on),
      onDimmerState: (where, brightness) => this.updateDimmerState(where, brightness),
      onBlindState: (where, direction) => this.updateBlindState(where, direction),
      onAdvancedBlindState: (where, direction, position) =>
        this.updateAdvancedBlindState(where, direction, position),
    });
    void this.client.start().catch((error: unknown) => {
      this.log.error('Não foi possível iniciar o OpenWebNet: %s', error instanceof Error ? error.message : String(error));
    });
  }

  private sendLight(device: Device, on: boolean): void {
    if (!this.client) {
      this.log.error('%s: OpenWebNet ainda não foi iniciado.', device.name);
      return;
    }
    void this.client.setLight(device.where, on).catch((error: unknown) => {
      this.log.error('%s: erro ao enviar comando (%s).', device.name, error instanceof Error ? error.message : String(error));
    });
  }

  private updateLightState(where: string, on: boolean): void {
    const accessory = this.lightAccessories.get(where) ?? this.dimmerAccessories.get(where);
    if (!accessory) return;
    this.states.set(where, on);
    accessory.context.on = on;
    const service = accessory.getService(this.api.hap.Service.Lightbulb);
    if (this.dimmerAccessories.has(where)) {
      const brightness = on ? Math.max(1, this.brightnessStates.get(where) ?? 100) : 0;
      this.brightnessStates.set(where, brightness);
      accessory.context.brightness = brightness;
      service?.getCharacteristic(this.api.hap.Characteristic.On).updateValue(on);
      service?.getCharacteristic(this.api.hap.Characteristic.Brightness).updateValue(brightness);
    } else {
      this.refreshCharacteristic(service?.getCharacteristic(this.api.hap.Characteristic.On));
    }
  }

  private updateDimmerState(where: string, brightness: number): void {
    const accessory = this.dimmerAccessories.get(where);
    if (!accessory) return;
    const on = brightness > 0;
    this.brightnessStates.set(where, brightness);
    this.states.set(where, on);
    accessory.context.brightness = brightness;
    accessory.context.on = on;
    const service = accessory.getService(this.api.hap.Service.Lightbulb);
    service?.getCharacteristic(this.api.hap.Characteristic.On).updateValue(on);
    service?.getCharacteristic(this.api.hap.Characteristic.Brightness).updateValue(brightness);
  }

  private moveBlindTo(accessory: PlatformAccessory, device: Blind, target: number): void {
    const runtime = this.runtime(device.where);
    this.estimateBlind(accessory, device, runtime);
    this.clearBlindTimers(runtime);
    runtime.target = target;
    accessory.context.targetPosition = target;
    if (target === runtime.current) {
      runtime.direction = 0;
      this.client?.setBlind(device.where, 0);
      this.updateBlindCharacteristics(accessory, runtime);
      return;
    }
    runtime.direction = target > runtime.current ? 1 : -1;
    runtime.startedAt = Date.now() + 500;
    runtime.startedFrom = runtime.current;
    runtime.ignoreStopUntil = Date.now() + 650;
    const physicalUp = device.invert ? runtime.direction < 0 : runtime.direction > 0;
    this.client?.setBlind(device.where, physicalUp ? 1 : 2);
    this.updateBlindCharacteristics(accessory, runtime);
    runtime.updateTimer = setInterval(() => {
      this.estimateBlind(accessory, device, runtime);
      this.updateBlindCharacteristics(accessory, runtime);
    }, 250);
    const duration = Math.max(100, device.travelTime * 10 * Math.abs(target - runtime.current));
    runtime.stopTimer = setTimeout(() => {
      this.client?.setBlind(device.where, 0);
      runtime.current = target;
      runtime.direction = 0;
      this.clearBlindTimers(runtime);
      this.updateBlindCharacteristics(accessory, runtime);
    }, duration + 500);
  }

  private updateBlindState(where: string, physicalDirection: 0 | 1 | 2): void {
    const accessory = this.blindAccessories.get(where);
    const device = this.blinds.find((blind) => blind.where === where);
    if (!accessory || !device) return;
    const runtime = this.runtime(where);
    this.estimateBlind(accessory, device, runtime);
    if (physicalDirection === 0) {
      if (Date.now() < runtime.ignoreStopUntil) return;
      runtime.direction = 0;
      runtime.target = runtime.current;
      this.clearBlindTimers(runtime);
      this.updateBlindCharacteristics(accessory, runtime);
      return;
    }
    const physicalLogical: -1 | 1 = physicalDirection === 1 ? 1 : -1;
    runtime.direction = device.invert
      ? (physicalLogical === 1 ? -1 : 1)
      : physicalLogical;
    runtime.startedAt = Date.now();
    runtime.startedFrom = runtime.current;
    runtime.target = runtime.direction > 0 ? 100 : 0;
    runtime.ignoreStopUntil = 0;
    clearInterval(runtime.updateTimer);
    runtime.updateTimer = setInterval(() => {
      this.estimateBlind(accessory, device, runtime);
      this.updateBlindCharacteristics(accessory, runtime);
    }, 250);
    this.updateBlindCharacteristics(accessory, runtime);
  }

  private updateAdvancedBlindState(
    where: string, direction: 'STOP' | 'UP' | 'DOWN', position: number,
  ): void {
    const accessory = this.advancedBlindAccessories.get(where);
    if (!accessory) return;
    const runtime = this.runtime(where);
    runtime.current = this.clamp(position);
    runtime.direction = direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : 0;
    if (runtime.direction === 0) runtime.target = runtime.current;
    this.updateBlindCharacteristics(accessory, runtime);
  }

  private estimateBlind(accessory: PlatformAccessory, device: Blind, runtime: BlindRuntime): void {
    if (!runtime.direction || Date.now() <= runtime.startedAt) return;
    const travelled = (Date.now() - runtime.startedAt) / (device.travelTime * 1_000) * 100;
    runtime.current = this.clamp(runtime.startedFrom + runtime.direction * travelled);
    accessory.context.currentPosition = runtime.current;
  }

  private updateBlindCharacteristics(accessory: PlatformAccessory, runtime: BlindRuntime): void {
    accessory.context.currentPosition = runtime.current;
    accessory.context.targetPosition = runtime.target;
    const service = accessory.getService(this.api.hap.Service.WindowCovering);
    service?.getCharacteristic(this.api.hap.Characteristic.CurrentPosition).updateValue(runtime.current);
    service?.getCharacteristic(this.api.hap.Characteristic.TargetPosition).updateValue(runtime.target);
    service?.getCharacteristic(this.api.hap.Characteristic.PositionState)
      .updateValue(this.positionState(runtime.direction));
  }

  private runtime(where: string): BlindRuntime {
    const runtime = this.blindRuntimes.get(where);
    if (!runtime) throw new Error(`Estado da persiana ${where} não foi inicializado.`);
    return runtime;
  }

  private clearBlindTimers(runtime: BlindRuntime): void {
    clearInterval(runtime.updateTimer);
    clearTimeout(runtime.stopTimer);
    runtime.updateTimer = undefined;
    runtime.stopTimer = undefined;
  }

  private positionState(direction: -1 | 0 | 1): number {
    const state = this.api.hap.Characteristic.PositionState;
    return direction > 0 ? state.INCREASING : direction < 0 ? state.DECREASING : state.STOPPED;
  }

  private clamp(value: number): number {
    return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  }

  private readDevices(
    key: 'lights' | 'dimmers' | 'advancedBlinds', label: string, used: Set<string>,
  ): Device[] {
    const configured = this.config[key];
    if (!Array.isArray(configured)) return [];
    return (configured as RawDevice[])
      .map((raw) => this.readDevice(raw, label, used))
      .filter((device): device is Device => device !== undefined);
  }

  private readBlinds(used: Set<string>): Blind[] {
    if (!Array.isArray(this.config.blinds)) return [];
    const blinds: Blind[] = [];
    for (const raw of this.config.blinds as RawDevice[]) {
      const device = this.readDevice(raw, 'persiana', used);
      const travelTime = Number(raw.travelTime);
      if (!device || !Number.isFinite(travelTime) || travelTime <= 0) {
        if (device) {
          used.delete(device.where);
          this.log.warn('%s foi ignorada porque o tempo de percurso é inválido.', device.name);
        }
        continue;
      }
      blinds.push({ ...device, travelTime, invert: Boolean(raw.invert ?? false) });
    }
    return blinds;
  }

  private readDevice(raw: RawDevice, label: string, used: Set<string>): Device | undefined {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const bus = this.readPart(raw.bus, 0);
    const area = this.readPart(raw.area);
    const point = this.readPart(raw.point);
    if (!name || bus === undefined || area === undefined || point === undefined) {
      this.log.warn('Um %s foi ignorado porque sua configuração está incompleta.', label);
      return undefined;
    }
    const where = this.toAddress(bus, area, point);
    if (used.has(where)) {
      this.log.warn('O dispositivo %s foi ignorado porque o endereço está repetido.', name);
      return undefined;
    }
    used.add(where);
    return { name, where };
  }

  private refreshCharacteristic(characteristic: unknown): void {
    if (!characteristic) return;
    (characteristic as { emit: (event: 'get', callback: () => void) => boolean })
      .emit('get', () => undefined);
  }

  private readPart(value: unknown, defaultValue?: number): number | undefined {
    if ((value === undefined || value === null || value === '') && defaultValue !== undefined) return defaultValue;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 99 ? number : undefined;
  }

  private toAddress(bus: number, area: number, point: number): string {
    const address = area >= 10 || point >= 10
      ? `${String(area).padStart(2, '0')}${String(point).padStart(2, '0')}`
      : `${area}${point}`;
    return bus === 0 ? address : `${address}#4#${String(bus).padStart(2, '0')}`;
  }
}

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MyHomeOpenWebNetPlatform);
};
