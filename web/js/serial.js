/**
 * serial.js
 * ---------------------------------------------------------------------------
 * Capa de transporte alternativa por puerto serie USB para Arduino/ESP32
 * usando la Web Serial API del navegador.
 * ---------------------------------------------------------------------------
 */

export class SerialNotSupportedError extends Error {
  constructor() {
    super(
      'Este navegador no soporta Web Serial. Usa Chrome o Edge en escritorio y conecta el Arduino por USB.'
    );
    this.name = 'SerialNotSupportedError';
  }
}

export class GruaSerialClient extends EventTarget {
  #port = null;
  #reader = null;
  #writer = null;
  #incomingBuffer = '';

  static isSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  get isConnected() {
    return Boolean(this.#port && this.#port.readable && this.#port.opened);
  }

  get deviceName() {
    return this.#port ? 'Arduino USB' : null;
  }

  async connect() {
    if (!GruaSerialClient.isSupported()) {
      throw new SerialNotSupportedError();
    }

    if (!this.#port) {
      const availablePorts = await navigator.serial.getPorts();
      this.#port = availablePorts[0] ?? await navigator.serial.requestPort();
    }

    if (!this.#port) {
      throw new Error('No se encontró ningún puerto USB del Arduino.');
    }

    await this.#port.open({ baudRate: 115200 });

    this.#reader = this.#port.readable.getReader();
    this.#writer = this.#port.writable.getWriter();

    this.#port.addEventListener('disconnect', () => {
      this.#cleanup();
      this.dispatchEvent(new CustomEvent('disconnected', { detail: {} }));
    });

    void this.#readLoop();
    this.dispatchEvent(new CustomEvent('connected', { detail: { deviceName: this.deviceName } }));
  }

  async disconnect() {
    if (!this.#port) return;

    try {
      this.#reader?.cancel();
    } catch {
      // Se ignora: el puerto puede haber sido cerrado o no estar listo.
    }

    try {
      await this.#port.close();
    } catch {
      // Si el puerto ya estaba cerrado, no hacemos ruido.
    }

    this.#cleanup();
    this.dispatchEvent(new CustomEvent('disconnected', { detail: {} }));
  }

  async send(command) {
    if (!this.#writer) {
      throw new Error('No hay conexión USB activa: conecta antes de enviar comandos.');
    }

    const payload = new TextEncoder().encode(`${command}\n`);
    await this.#writer.write(payload);
  }

  async #readLoop() {
    try {
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await this.#reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }

        const text = decoder.decode(value, { stream: true });
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
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: { error } }));
      this.dispatchEvent(new CustomEvent('disconnected', { detail: {} }));
    } finally {
      this.#cleanup();
    }
  }

  #cleanup() {
    try {
      this.#reader?.releaseLock();
    } catch {
      // Ignorado.
    }
    try {
      this.#writer?.releaseLock();
    } catch {
      // Ignorado.
    }
    this.#reader = null;
    this.#writer = null;
    this.#incomingBuffer = '';
  }
}
