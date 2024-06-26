const EventEmitter = require('events');
const net = require('net');
const debug = require('debug')('ph803w:device');
const VarintBufferReader = require('./varint-buffer-reader');

const PH803W_DEFAULT_TCP_PORT = 12416;
const PH803W_PING_INTERVAL = 4000;
const RECONNECT_DELAY = 10000;
const RESPONSE_TIMEOUT = 5000;

/**
 * Utility function to create a Promise that can be resolved/rejected deferred
 *
 * @returns {Promise<any>}
 */
function getDeferredPromise() {
    let res;
    let rej;

    const resultPromise = new Promise((resolve, reject) => {
        res = resolve;
        rej = reject;
    });

    // @ts-ignore
    resultPromise.resolve = res;
    // @ts-ignore
    resultPromise.reject = rej;

    return resultPromise;
}

/**
 * This class connects to a PH803W device on a provided IP address,
 * handles the relevant authentication calls and receives data-updates from the device
 */
class PH803WDevice extends EventEmitter {

    /**
     * Constructor for PH803W device
     *
     * @param {string} [ip] IP address of the device, alternatively an options object can be provided, or both
     * @param {object} [options] Options object to set/overwrite some settings, IP needs to be provided as first parameter or as part of this object
     * @param {string} [options.ip] IP of the device
     * @param {number} [options.port=12416] Port of the device, defaults to 12416 if not provided
     * @param {string} [options.devicePasscode] Passcode of the device if known, if unknown it will be queried from the device during authentication
     * @param {boolean} [options.autoReconnect=true] Defines if the library should automatically reconnect to the device if connection was lost
     * @param {number} [options.reconnectDelay=10000] Delay in ms after a disconnect until a reconnect is done
     * @param {number} [options.responseTimeout=5000] How long (ms) the library waits for an answer from te device before the reject fails
     * @param {number} [options.pingInterval=4000] Interval in ms to send out new ping requests to the device
     */
    constructor(ip, options) {
        super();

        if (typeof ip === 'object') {
            options = ip;
            ip = '';
        }
        this.options = options || {};
        this.options.ip = ip || this.options.ip;
        if (!this.options.ip) {
            throw new Error('No IP provided for Device');
        }

        this.socket = null;
        this.pingTimeout = null;
        this.pingWaitTimeout = null;
        this.autoReconnect = this.options.autoReconnect !== undefined ? this.options.autoReconnect : true;
        this.reconnectTimeout = null;

        this.expectedResponsePromises = {};

        this.connected = false;
    }

    /**
     * Connect to the device, do authentication calls and register for data updates
     *
     * @returns {Promise<boolean>} resolves with true when connected successfully
     *
     * @emits connected
     * @emits error
     */
    connect() {
        return new Promise((resolve, reject) => {
            if (this.socket) {
                reject(new Error('Already connected to device'));
                return;
            }
            if (!this.options.ip) {
                throw new Error('No IP provided for Device');
            }

            this.socket = new net.Socket();

            const port = this.options.port || PH803W_DEFAULT_TCP_PORT;
            this.socket.connect(port, this.options.ip, () => {
                debug(`Connected to TCP ${this.options.ip}:${port}`);
                this.connected = true;
                /**
                 * Connected event emitted when connection was established successfully
                 */
                this.emit('connected');
                resolve(true);
            });

            this.socket.on('data', data => {
                if (!data || !Buffer.isBuffer(data)) {
                    return;
                }
                this._handleData(data);
            });

            this.socket.on('error', err => {
                debug('Socket error: ' + err);
                /**
                 * Error event when connection has errors
                 */
                this.emit('error', err);
                try {
                    this.socket && this.socket.destroy();
                } catch {
                    // ignore
                }
                this.socket = null;
                this.connected = false;
                this._handleReconnect();
            });

            this.socket.on('end', () => {
                debug(`Socket end, Reconnect: ${this.autoReconnect}`);
                this.socket = null;
                this.connected = false;
                this._handleReconnect();
            });

            this.socket.on('close', () => {
                debug(`Socket close`);
                this.socket = null;
                this.connected = false;
                this._handleReconnect();
            });
        });
    }

    /**
     * Returns the current connection status
     * @returns {boolean}
     */
    isConnected() {
        return this.connected;
    }

    /**
     * Helper method to handle reconnection to the device
     *
     * @private
     */
    _handleReconnect() {
        if (this.reconnectTimeout) {
            return;
        }
        /**
         * Disconnected event emitted when decide got disconnected
         */
        this.emit('disconnected');
        if (this.autoReconnect) {
            debug('Handle reconnect');
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout);
            }
            this.reconnectTimeout = setTimeout(() => {
                this.reconnectTimeout = null;
                this.connect();
            }, this.options.reconnectDelay || RECONNECT_DELAY);
        }
    }

    /**
     * Closes the connection to the device and allows to define if an automatic reconnect should happen or not
     * @param {boolean} reconnect true to do an automatic reconnect, false if not
     *
     * @returns {Promise<boolean>} Resolves with true when connection is closed
     */
    close(reconnect) {
        this.autoReconnect = reconnect;
        if (this.pingTimeout) {
            clearTimeout(this.pingTimeout);
            this.pingTimeout = null;
        }
        if (this.pingWaitTimeout) {
            clearTimeout(this.pingWaitTimeout);
            this.pingWaitTimeout = null;
        }
        Object.keys(this.expectedResponsePromises).forEach(res => {
            clearTimeout(this.expectedResponsePromises[res].responseTimeout);
            this.expectedResponsePromises[res].responsePromise.reject();
        });
        this.expectedResponsePromises = {};
        return new Promise(resolve => {
            if (this.socket) {
                debug('Destroy socket');
                this.socket.destroy();
                this.socket = null;
            }
            resolve(true);
        });
    }

    /**
     * Closes the device connection without reconnect
     *
     * @returns {Promise<boolean>} Resolves with true when connection is closed
     */
    destroy() {
        return this.close(false);
    }

    /**
     * Sends a command to the device and registers a promise to be resolved when response was received
     *
     * @param {Buffer} reqBuffer Request Buffer to send out
     * @param {number} responseType Expected Message type from device for response
     * @returns {Promise<*>} Promise that resolves on response
     * @private
     */
    _sendAndRegisterForResponse(reqBuffer, responseType) {
        if (!this.socket) {
            return Promise.reject(new Error('Device not connected'));
        }

        if (this.expectedResponsePromises[responseType]) {
            return this.expectedResponsePromises[responseType].responsePromise;
        }

        debug(`Write and register for response type ${responseType}: ${reqBuffer.toString('hex')}`);
        this.socket.write(reqBuffer);

        const responsePromise = getDeferredPromise();

        this.expectedResponsePromises[responseType] = {
            responseType,
            responsePromise,
            responseTimeout: setTimeout(() => {
                if (this.expectedResponsePromises[responseType]) {
                    debug(`Reject registered responses for response type ${responseType}`);
                    this.expectedResponsePromises[responseType].responsePromise.reject();
                    delete this.expectedResponsePromises[responseType];
                }
            }, this.options.responseTimeout || RESPONSE_TIMEOUT)
        };
        return responsePromise;
    }

    /**
     * Helper method to determine the relevant stored promise to resolve after a certain response was received
     * @param {number} responseType Message type of response
     * @param {object} result Parsed response to resolve promise with
     * @private
     */
    _resolveResponse(responseType, result) {
        if (!this.expectedResponsePromises[responseType]) {
            debug(`Ignore resolve for message type ${responseType} because no promise stored: ${JSON.stringify(result)}`);
            return;
        }
        debug(`Resolve for message type ${responseType}: ${JSON.stringify(result)}`);
        this.expectedResponsePromises[responseType].responsePromise.resolve(result);
        delete this.expectedResponsePromises[responseType];
    }

    /**
     * Helper method to determine the relevant stored promise to reject after a certain response was received
     * @param {number} responseType Message type of response
     * @param {object} result Parsed response to reject promise with
     * @private
     */
    _rejectResponse(responseType, result) {
        if (!this.expectedResponsePromises[responseType]) {
            debug(`Ignore reject for message type ${responseType} because no promise stored: ${JSON.stringify(result)}`);
            return;
        }
        debug(`Reject for message type ${responseType}: ${JSON.stringify(result)}`);
        this.expectedResponsePromises[responseType].responsePromise.reject(result);
        delete this.expectedResponsePromises[responseType];
    }

    /**
     * Retrieve Passcode to use for Authentication from device
     *
     * @returns {Promise<*>}
     */
    getPasscode() {
        const reqBuffer = Buffer.from('0000000303000006', 'hex');
        return this._sendAndRegisterForResponse(reqBuffer, 0x07);
    }

    /**
     * Login to Device by using passcode
     *
     * @param {string} passcode Passcode of device
     * @returns {Promise<*>}
     */
    async login(passcode) {
        if (passcode) {
            this.options.devicePasscode = passcode;
        }
        if (! this.options.devicePasscode) {
            this.options.devicePasscode = await this.getPasscode();
        }

        let passcodeBuffer;
        if (typeof this.options.devicePasscode === 'string') {
            passcodeBuffer = Buffer.from(this.options.devicePasscode, 'utf-8');
        } else if (Buffer.isBuffer(this.options.devicePasscode)) {
            passcodeBuffer = this.options.devicePasscode;
        } else {
            throw new Error(`Invalid passcode ${this.options.devicePasscode}`);
        }

        const loginBuffer = Buffer.from('00000003030000080000', 'hex');
        loginBuffer.writeUInt8(passcodeBuffer.length, loginBuffer.length - 1);
        loginBuffer.writeUInt8(5 + passcodeBuffer.length, 4);

        return this._sendAndRegisterForResponse(Buffer.concat([loginBuffer, passcodeBuffer]), 0x09);
    }

    /**
     * Get data from device and register for automatic data updates (emits "data" event then)
     *
     * @returns {Promise<*>}
     */
    retrieveData() {
        const dataBuffer = Buffer.from('000000030400009002', 'hex');

        return this._sendAndRegisterForResponse(dataBuffer, 0x91);
    }

    /**
     * Check and parse received data from device
     *
     * @param {Buffer} message Received data
     * @private
     */
    _handleData(message) {
        const messageReader = new VarintBufferReader(message);
        try {
            if (messageReader.nextUInt32BE() !== 0x00000003) {
                debug(`Ignore data package because invalid prefix: ${message.toString('hex')}`);
                return;
            }
        } catch (err) {
            debug(`Ignore data package because short prefix: ${message.toString('hex')}`);
            return;
        }

        let dataLength;
        try {
            dataLength = messageReader.nextVarint();
        }
        catch {
            debug(`Ignore data package because invalid length: ${message.toString('hex')}`);
            this.emit('error', `Ignore data package because invalid length`, message);
            return;
        }

        const headerLength =  messageReader.tell();
        messageReader.seek(0);
        let data;
        try {
            data = messageReader.nextBuffer(headerLength + dataLength);
        }
        catch {
            debug(`Ignore data package because invalid length: ${message.toString('hex')}`);
            this.emit('error', `Ignore data package because invalid length`, message);
            return;
        }

        const rest = messageReader.restAll();
        if (rest.length > 0) {
            debug(`Split into two data packages because additional data detected. First ${data.toString('hex')} - Second ${rest.toString('hex')}`);
            setImmediate(() => this._handleData(rest));
        }

        const dataReader = new VarintBufferReader(data);
        dataReader.seek(headerLength);
        const flag = dataReader.nextInt8();
        if (flag !== 0x00) {
            debug(`Ignore data package because invalid flag ${flag}: ${message.toString('hex')}`);
            return;
        }
        const messageType = dataReader.nextInt16BE();
        switch (messageType) {
            case 0x07:
                this._handlePasscodeResponse(dataReader.restAll());
                break;
            case 0x09:
                this._handleLoginResponse(dataReader.restAll());
                break;
            case 0x16:
                this._handlePingPongResponse();
                break;
            case 0x91:
                this._handleDataResponse(dataReader.restAll());
                break;
            case 0x94:
                this._handleDataExtendedResponse(dataReader.restAll());
                break;
            default:
                debug(`Ignore data package because invalid message type ${messageType}: ${message.toString('hex')}`);
                this.emit('error', `Ignore data package because invalid message type ${messageType}`, message);
                return;
        }
    }

    /**
     * Handle a Passcode-Response from Device
     *
     * @param {Buffer} data Received data
     * @private
     */
    _handlePasscodeResponse(data) {
        const dataReader = new VarintBufferReader(data);
        const passcodeLength = dataReader.nextUInt16BE();
        const passcode = dataReader.nextBuffer(passcodeLength);
        debug(`Passcode received: ${passcode}`);

        this._resolveResponse(0x07, passcode);
    }

    /**
     * Handle a Login-Response from Device
     *
     * @param {Buffer} data Received data
     * @private
     */
    _handleLoginResponse(data) {
        const dataReader = new VarintBufferReader(data);
        if (dataReader.nextInt8() === 0x00) {
            debug('login success');
            this._resolveResponse(0x09, true);
            this.pingTimeout = setTimeout(() => {
                this.pingTimeout = null;
                this._sendPing();
            }, this.options.pingInterval || PH803W_PING_INTERVAL);
        } else {
            debug('login failed');
            this._rejectResponse(0x09, new Error('Login rejected by device, check the passcode'));
        }
    }

    /**
     * Handle a PingPong-Response from Device
     *
     * @private
     */
    _handlePingPongResponse() {
        if (this.pingWaitTimeout) {
            clearTimeout(this.pingWaitTimeout);
            this.pingWaitTimeout = null;
        }
        if (this.pingTimeout) {
            clearTimeout(this.pingTimeout);
            this.pingTimeout = null;
        }
        debug('received pong');
        this.pingTimeout = setTimeout(() => {
            this.pingTimeout = null;
            this._sendPing();
        }, this.options.pingInterval || PH803W_PING_INTERVAL);
    }

    /**
     * Handle a Data-Response from Device
     *
     * @param {Buffer} data Received data
     * @private
     */
    _handleDataResponse(data) {
        const dataReader = new VarintBufferReader(data);
        // `00 00 00 03 0d 00 00 91 ?? ?? 02 dc 08 9d 00 00 00 00`
        const binFlags1 = dataReader.nextInt8();
        const binFlags2 = dataReader.nextInt8();
        const ph = dataReader.nextUInt16BE() / 100;
        const redox = dataReader.nextUInt16BE() - 2000;

        const res = {
            binFlags1: binFlags1.toString(2),
            binFlags2: binFlags2.toString(2),
            ph,
            redox,
            phOutlet: ((binFlags2>>0) % 2 !== 0),
            redoxOutlet: ((binFlags2>>1) % 2 !== 0)
        };
        debug(`Retrieved data: ${JSON.stringify(res)}`);
        /**
         * Event with Data from device
         *
         * @param {object} res Object with response data
         * @param {string} res.binFlags1 String with Binary representation of data1 field -  for further analysis
         * @param {string} res.binFlags2 String with Binary representation of data2 field -  for further analysis
         * @param {number} res.ph PH value
         * @param {number} res.redox Redox value in mV
         * @param {boolean} res.phOutlet true when the PH control outlet is turned on
         * @param {boolean} res.redoxOutlet true when the Redox control outlet is turned on
         */
        this.emit('data', res);
        this._resolveResponse(0x91, res);
    }

    /**
     * Handle an extended Data-Response from Device; For now same data are extracted as for normal data telegram
     *
     * @param {Buffer} data Received data
     * @private
     */
    _handleDataExtendedResponse(data) {
        const dataReader = new VarintBufferReader(data);
        const sn = dataReader.nextUInt32BE();
        // `00 00 00 03 11 00 00 94 00 00 00 04 03 00 02 dc 08 9d 00 00 00 00`
        const binFlags1 = dataReader.nextInt8();
        const binFlags2 = dataReader.nextInt8();
        const ph = dataReader.nextUInt16BE() / 100;
        const redox = dataReader.nextUInt16BE() - 2000;

        const res = {
            sn,
            binFlags1: binFlags1.toString(2),
            binFlags2: binFlags2.toString(2),
            ph,
            redox,
            phOutlet: ((binFlags2>>0) % 2 !== 0),
            redoxOutlet: ((binFlags2>>1) % 2 !== 0)
        };
        debug(`Retrieved data: ${JSON.stringify(res)}`);
        this.emit('data', res);
        this._resolveResponse(0x94, res);
    }

    /**
     * Sends out a Ping request and awaits Pong
     *
     * @private
     */
    _sendPing() {
        if (!this.socket) {
            return;
        }
        if (this.pingTimeout) {
            clearTimeout(this.pingTimeout);
            this.pingTimeout = null;
        }
        if (this.pingWaitTimeout) {
            clearTimeout(this.pingWaitTimeout);
            this.pingWaitTimeout = null;
        }
        const pingBuffer = Buffer.from('0000000303000015', 'hex');
        this.socket.write(pingBuffer);
        debug('Send ping');
        this.pingWaitTimeout = setTimeout(() => {
            debug('Ping response overdue, reconnect');
            this.close(true);
        }, (this.options.pingInterval || PH803W_PING_INTERVAL) * 2);
    }
}

module.exports = PH803WDevice;
