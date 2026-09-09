import { OpenWebNetClient } from './openwebnet.js';
const PLUGIN_NAME = 'homebridge-myhome-openwebnet';
const PLATFORM_NAME = 'MyHomeOpenWebNet';
class MyHomeOpenWebNetPlatform {
    log;
    config;
    api;
    client;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.log.info('MyHome OpenWebNet plugin iniciado.');
        this.api.on('didFinishLaunching', () => {
            this.start();
        });
    }
    configureAccessory(accessory) {
        this.log.info('Acessório carregado do cache: %s', accessory.displayName);
    }
    async start() {
        const host = this.config.host;
        const port = Number(this.config.port ?? 20000);
        if (!host) {
            this.log.error('IP do gateway OpenWebNet não configurado.');
            return;
        }
        this.client = new OpenWebNetClient({
            host,
            port,
        }, (message) => this.log.info(message));
        try {
            await this.client.connect();
            await this.client.openCommandSession();
            this.log.info('Conectado e autenticado na sessão OpenWebNet.');
            await this.client.setLight('01', true);
            this.log.info('Teste concluído: comando ON enviado para a luz 01.');
        }
        catch (error) {
            const message = error instanceof Error
                ? error.message
                : String(error);
            this.log.error(`Erro OpenWebNet: ${message}`);
        }
    }
}
export default (api) => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MyHomeOpenWebNetPlatform);
};
