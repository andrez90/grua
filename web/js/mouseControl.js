/**
 * mouseControl.js
 * ---------------------------------------------------------------------------
 * Control de la grúa por arrastre del ratón en una superficie 2D.
 * X del ratón → ángulo de la Base
 * Y del ratón → ángulo del Hombro
 * Rueda del ratón → ángulo del Codo
 * ---------------------------------------------------------------------------
 */

export class MouseControl {
  #zone = null;
  #canvas = null;
  #ctx = null;
  #isDragging = false;
  #isMovingToTarget = false;

  // Estado actual y objetivo
  #currentBaseAngle = 90;
  #currentHombroAngle = 140;
  #currentCodoAngle = 90;
  #targetBaseAngle = 90;
  #targetHombroAngle = 140;
  #targetCodoAngle = 90;

  // Configuración
  #approachStepDegrees = 2;
  #moveTickMs = 20; // cada 20ms se acerca un paso hacia el objetivo

  // Callbacks
  #onServoChange = null;

  // Límites de servos (obtienen del protocolo)
  #servos = null;

  // Timer de movimiento suave
  #moveTimer = null;

  constructor(zoneSelector, servos) {
    this.#zone = document.querySelector(zoneSelector);
    this.#servos = servos;

    if (!this.#zone) {
      console.error(`No se encontró la zona: ${zoneSelector}`);
      return;
    }

    // Crear canvas para dibujar
    this.#canvas = document.createElement('canvas');
    this.#ctx = this.#canvas.getContext('2d');
    this.#zone.appendChild(this.#canvas);

    // Redimensionar canvas al tamaño del contenedor
    this.#resizeCanvas();
    window.addEventListener('resize', () => this.#resizeCanvas());

    // Event listeners
    this.#zone.addEventListener('mousedown', (e) => this.#onMouseDown(e));
    this.#zone.addEventListener('mousemove', (e) => this.#onMouseMove(e));
    this.#zone.addEventListener('mouseup', (e) => this.#onMouseUp(e));
    this.#zone.addEventListener('mouseleave', (e) => this.#onMouseLeave(e));
    this.#zone.addEventListener('wheel', (e) => this.#onMouseWheel(e), { passive: false });

    // Timer de movimiento suave
    this.#moveTimer = setInterval(() => this.#moveLoopTick(), this.#moveTickMs);

    // Dibujar estado inicial
    this.#draw();
  }

  #resizeCanvas() {
    this.#canvas.width = this.#zone.offsetWidth;
    this.#canvas.height = this.#zone.offsetHeight;
    this.#draw();
  }

  #onMouseDown(e) {
    if (e.button === 0) {
      // Click izquierdo
      this.#isDragging = true;
      this.#updateTargetFromMouse(e.offsetX, e.offsetY);
    }
  }

  #onMouseMove(e) {
    if (!this.#isDragging) return;
    this.#updateTargetFromMouse(e.offsetX, e.offsetY);
  }

  #onMouseUp(e) {
    if (e.button === 0) {
      this.#isDragging = false;
      // El objetivo se queda donde estaba; el brazo termina de acercarse solo
    }
  }

  #onMouseLeave(e) {
    this.#isDragging = false;
  }

  #onMouseWheel(e) {
    e.preventDefault();
    
    const codoConfig = this.#servos.codo;
    if (!codoConfig) return;

    // scroll down = recoger (menos grados), scroll up = extender (más grados)
    const step = e.deltaY > 0 ? -3 : 3;
    const newAngle = Math.max(codoConfig.min, Math.min(codoConfig.max, this.#currentHombroAngle + step));
    
    this.#currentHombroAngle = newAngle;
    
    if (this.#onServoChange) {
      this.#onServoChange('codo', Math.round(newAngle));
    }
    
    this.#draw();
  }

  #updateTargetFromMouse(x, y) {
    x = Math.max(0, Math.min(x, this.#canvas.width));
    y = Math.max(0, Math.min(y, this.#canvas.height));

    const baseConfig = this.#servos.base;
    const hombroConfig = this.#servos.hombro;

    // X → Base
    this.#targetBaseAngle = this.#mapRange(x, 0, this.#canvas.width, baseConfig.min, baseConfig.max);

    // Y → Hombro (invertido: arriba = máximo, abajo = mínimo)
    this.#targetHombroAngle = this.#mapRange(y, 0, this.#canvas.height, hombroConfig.max, hombroConfig.min);

    this.#draw();
  }

  #moveLoopTick() {
    if (this.#isMovingToTarget) return; // evitar pelear si estamos volviendo a home

    let moved = false;

    const newBase = this.#approachTowards(this.#currentBaseAngle, this.#targetBaseAngle);
    if (Math.abs(newBase - this.#currentBaseAngle) > 0.01) {
      this.#currentBaseAngle = newBase;
      if (this.#onServoChange) {
        this.#onServoChange('base', Math.round(this.#currentBaseAngle));
      }
      moved = true;
    }

    const newHombro = this.#approachTowards(this.#currentHombroAngle, this.#targetHombroAngle);
    if (Math.abs(newHombro - this.#currentHombroAngle) > 0.01) {
      this.#currentHombroAngle = newHombro;
      if (this.#onServoChange) {
        this.#onServoChange('hombro', Math.round(this.#currentHombroAngle));
      }
      moved = true;
    }

    if (moved) {
      this.#draw();
    }
  }

  #approachTowards(current, target) {
    if (Math.abs(target - current) <= 0.01) return target;
    const direction = target > current ? 1 : -1;
    return current + direction * Math.min(this.#approachStepDegrees, Math.abs(target - current));
  }

  #mapRange(value, inMin, inMax, outMin, outMax) {
    return ((value - inMin) / (inMax - inMin)) * (outMax - outMin) + outMin;
  }

  #draw() {
    const width = this.#canvas.width;
    const height = this.#canvas.height;

    // Limpiar
    this.#ctx.fillStyle = getComputedStyle(this.#zone).backgroundColor;
    this.#ctx.fillRect(0, 0, width, height);

    // Convertir ángulos actuales a posición en el canvas
    const baseConfig = this.#servos.base;
    const hombroConfig = this.#servos.hombro;

    const px = this.#mapRange(this.#currentBaseAngle, baseConfig.min, baseConfig.max, 0, width);
    const py = this.#mapRange(this.#currentHombroAngle, hombroConfig.max, hombroConfig.min, 0, height);

    // Dibujar punto de posición actual
    const radius = 8;
    this.#ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
    this.#ctx.beginPath();
    this.#ctx.arc(px, py, radius, 0, Math.PI * 2);
    this.#ctx.fill();

    // Borde blanco
    this.#ctx.strokeStyle = '#ffffff';
    this.#ctx.lineWidth = 2;
    this.#ctx.stroke();

    // Etiqueta con los ángulos
    const text = `Base ${Math.round(this.#currentBaseAngle)}° · Hombro ${Math.round(this.#currentHombroAngle)}°`;
    this.#ctx.font = 'bold 10px "Segoe UI"';
    this.#ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim();

    const metrics = this.#ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = 14;

    let textX = px - textWidth / 2;
    let textY = py + radius + 12;

    // Si no cabe abajo, poner arriba
    if (textY + textHeight > height) {
      textY = py - radius - 8;
    }

    textX = Math.max(4, Math.min(textX, width - textWidth - 4));

    // Fondo blanco para la etiqueta
    this.#ctx.fillStyle = '#ffffff';
    this.#ctx.fillRect(textX - 4, textY - 2, textWidth + 8, textHeight + 4);

    // Texto
    this.#ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim();
    this.#ctx.fillText(text, textX, textY + 10);
  }

  // Volver a la posición home (suavemente)
  async goToHome(baseHome, hombroHome) {
    this.#isMovingToTarget = true;
    this.#targetBaseAngle = baseHome;
    this.#targetHombroAngle = hombroHome;

    // Esperar hasta que se alcance el objetivo
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (
          Math.abs(this.#currentBaseAngle - baseHome) < 0.5 &&
          Math.abs(this.#currentHombroAngle - hombroHome) < 0.5
        ) {
          clearInterval(checkInterval);
          this.#isMovingToTarget = false;
          this.#currentBaseAngle = baseHome;
          this.#currentHombroAngle = hombroHome;
          this.#draw();
          resolve();
        }
      }, 50);
    });
  }

  // Registrar callback cuando los ángulos cambian
  onServoChange(callback) {
    this.#onServoChange = callback;
  }

  // Obtener ángulos actuales
  getCurrentAngles() {
    return {
      base: Math.round(this.#currentBaseAngle),
      hombro: Math.round(this.#currentHombroAngle),
    };
  }

  // Actualizar elementos visuales de información
  updateInfoDisplay(baseEl, hombroEl) {
    if (baseEl) baseEl.textContent = Math.round(this.#currentBaseAngle);
    if (hombroEl) hombroEl.textContent = Math.round(this.#currentHombroAngle);
  }

  destroy() {
    if (this.#moveTimer) clearInterval(this.#moveTimer);
    this.#zone.removeEventListener('mousedown', (e) => this.#onMouseDown(e));
    this.#zone.removeEventListener('mousemove', (e) => this.#onMouseMove(e));
    this.#zone.removeEventListener('mouseup', (e) => this.#onMouseUp(e));
    this.#zone.removeEventListener('mouseleave', (e) => this.#onMouseLeave(e));
    this.#zone.removeEventListener('wheel', (e) => this.#onMouseWheel(e));
  }
}
