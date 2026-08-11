/**
 * ble.js
 * ----------------------------------------------------------------------------
 * Capa de transporte: todo lo que sabe hablar con la Web Bluetooth API queda
 * encapsulado aquí, detrás de una interfaz simple (connect/disconnect/send +
 * eventos). La interfaz (ui.js) y el protocolo (protocol.js) no necesitan
 * saber nada sobre GATT, características ni UUIDs.
 *
 * Requiere un navegador con soporte de Web Bluetooth (Chrome/Edge de
 * escritorio, Chrome en Android). No funciona en Safari/iOS ni en Firefox:
 * ver README para el detalle de compatibilidad.
 * ----------------------------------------------------------------------------
 */

// Nordic UART Service (NUS): mismos UUID que expone el firmware (grua_ble.ino).
export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX_CHARACTERISTIC_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // escribimos aquí
export const NUS_TX_CHARACTERISTIC_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notificaciones del ESP32

/** Nombre por el que el ESP32 se anuncia (debe coincidir con BLE_DEVICE_NAME en el firmware). */
export const DEVICE_NAME_PREFIX = 'Grua';

export class BluetoothNotSupportedError extends Error {
  constructor() {
    super(
      'Este navegador no soporta Web Bluetooth. Usa Chrome o Edge en escritorio o Android, sobre HTTPS o localhost.'
    );
    this.name = 'BluetoothNotSupportedError';
  }
}

/**
 * Cliente BLE para la Grúa. Emite eventos de DOM estándar (`addEventListener`)
 * para mantenerse desacoplado del resto de la app:
 *   - 'connected'    detail: { deviceName }
 *   - 'disconnected' detail: {}
 *   - 'line'         detail: { line: string }   -> una línea de texto del firmware
 *   - 'error'        detail: { error: Error }
 */
export class GruaBleClient extends EventTarget {
  #device = null;
  #server = null;
  #rxCharacteristic = null;
  #txCharacteristic = null;
  #incomingBuffer = '';

  static isSupported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  get isConnected() {
    return Boolean(this.#device?.gatt?.connected);
  }

  get deviceName() {
    return this.#device?.name ?? null;
  }

  /**
   * Abre el selector nativo de dispositivos Bluetooth del navegador,
   * filtrando solo por los que anuncian el servicio UART, y se conecta.
   */
  async connect() {
    if (!GruaBleClient.isSupported()) {
      throw new BluetoothNotSupportedError();
    }

    this.#device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS_SERVICE_UUID] }, { namePrefix: DEVICE_NAME_PREFIX }],
      optionalServices: [NUS_SERVICE_UUID],
    });

    this.#device.addEventListener('gattserverdisconnected', this.#handleDisconnected);

    this.#server = await this.#device.gatt.connect();
    const service = await this.#server.getPrimaryService(NUS_SERVICE_UUID);
    this.#rxCharacteristic = await service.getCharacteristic(NUS_RX_CHARACTERISTIC_UUID);
    this.#txCharacteristic = await service.getCharacteristic(NUS_TX_CHARACTERISTIC_UUID);

    await this.#txCharacteristic.startNotifications();
    this.#txCharacteristic.addEventListener('characteristicvaluechanged', this.#handleNotification);

    this.dispatchEvent(new CustomEvent('connected', { detail: { deviceName: this.deviceName } }));
  }

  async disconnect() {
    if (this.#device?.gatt?.connected) {
      this.#device.gatt.disconnect();
    }
  }

  /**
   * Envía una línea de comando (se le agrega el salto de línea que espera
   * el firmware). Lanza si no hay conexión activa: quien llame decide cómo
   * mostrar ese error (ver ui.js).
   * @param {string} command
   */
  async send(command) {
    if (!this.#rxCharacteristic) {
      throw new Error('No hay conexión BLE activa: conecta antes de enviar comandos.');
    }
    const payload = new TextEncoder().encode(`${command}\n`);
    if (typeof this.#rxCharacteristic.writeValueWithoutResponse === 'function') {
      await this.#rxCharacteristic.writeValueWithoutResponse(payload);
    } else {
      await this.#rxCharacteristic.writeValue(payload);
    }
  }

  #handleNotification = (event) => {
    const value = event.target.value; // DataView
    const text = new TextDecoder().decode(value);
    this.#incomingBuffer += text;

    let newlineIndex;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIndex = this.#incomingBuffer.indexOf('\n')) !== -1) {
      const line = this.#incomingBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.#incomingBuffer = this.#incomingBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.dispatchEvent(new CustomEvent('line', { detail: { line } }));
      }
    }
  };

  #handleDisconnected = () => {
    this.#rxCharacteristic = null;
    this.#txCharacteristic = null;
    this.#server = null;
    this.#incomingBuffer = '';
    this.dispatchEvent(new CustomEvent('disconnected', { detail: {} }));
  };
}
