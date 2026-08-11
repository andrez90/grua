// Pruebas unitarias del protocolo de comandos (QA).
// Se ejecutan con el test runner nativo de Node (>=18): `npm test`
// No requieren navegador, BLE, ni hardware conectado: son pruebas puras
// sobre protocol.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVOS,
  clampAngle,
  mirrorAngle,
  buildServoCommand,
  buildRecordingCommand,
  buildIdentityCommand,
  parseIncomingLine,
  nextAngleForDirection,
  RECORDING_SLOT_COUNT,
} from '../web/js/protocol.js';

test('clampAngle recorta valores fuera de rango', () => {
  assert.equal(clampAngle(0, 180, -50), 0);
  assert.equal(clampAngle(0, 180, 500), 180);
  assert.equal(clampAngle(0, 180, 90), 90);
});

test('clampAngle redondea decimales', () => {
  assert.equal(clampAngle(0, 180, 90.6), 91);
  assert.equal(clampAngle(0, 180, 90.4), 90);
});

test('clampAngle lanza error con valores no numéricos', () => {
  assert.throws(() => clampAngle(0, 180, 'no-es-un-numero'), TypeError);
});

test('mirrorAngle refleja el ángulo dentro de su propio rango', () => {
  assert.equal(mirrorAngle(0, 180, 0), 180);
  assert.equal(mirrorAngle(0, 180, 180), 0);
  assert.equal(mirrorAngle(0, 180, 90), 90);
});

test('buildServoCommand: la Base se manda espejada (coincide con la app de escritorio)', () => {
  const result = buildServoCommand('base', 30);
  assert.equal(result.uiValue, 30);
  assert.equal(result.physicalAngle, 150); // 0 + 180 - 30
  assert.equal(result.command, 'S1:150');
});

test('buildServoCommand: el Codo se manda directo, sin espejo', () => {
  const result = buildServoCommand('codo', 45);
  assert.equal(result.physicalAngle, 45);
  assert.equal(result.command, 'S2:45');
});

test('buildServoCommand recorta al rango propio de cada servo (ej. Pinza 80-145)', () => {
  const result = buildServoCommand('pinza', 999);
  assert.equal(result.uiValue, 145);
  assert.equal(result.command, 'S4:145');

  const tooLow = buildServoCommand('pinza', 0);
  assert.equal(tooLow.uiValue, 80);
  assert.equal(tooLow.command, 'S4:80');
});

test('buildServoCommand acepta también el objeto de configuración directamente', () => {
  const result = buildServoCommand(SERVOS.hombro, 200);
  assert.equal(result.uiValue, 180);
  assert.equal(result.command, 'S3:180');
});

test('buildServoCommand lanza error con un servo desconocido', () => {
  assert.throws(() => buildServoCommand('no-existe', 90), RangeError);
});

test('nextAngleForDirection avanza y retrocede el paso indicado', () => {
  assert.equal(nextAngleForDirection(0, 180, 90, 1, 5), 95);
  assert.equal(nextAngleForDirection(0, 180, 90, -1, 5), 85);
  assert.equal(nextAngleForDirection(0, 180, 90, 0, 5), 90);
});

test('nextAngleForDirection recorta al llegar a los límites del servo (control tipo joystick)', () => {
  assert.equal(nextAngleForDirection(0, 180, 178, 1, 5), 180);
  assert.equal(nextAngleForDirection(0, 180, 2, -1, 5), 0);
  assert.equal(nextAngleForDirection(80, 145, 143, 1, 5), 145);
});

test('nextAngleForDirection rechaza direcciones inválidas', () => {
  assert.throws(() => nextAngleForDirection(0, 180, 90, 2, 5), RangeError);
  assert.throws(() => nextAngleForDirection(0, 180, 90, 0.5, 5), RangeError);
});

test('buildRecordingCommand genera los comandos REC:* esperados', () => {
  assert.equal(buildRecordingCommand.start(1), 'REC:START:1');
  assert.equal(buildRecordingCommand.play(6), 'REC:PLAY:6');
  assert.equal(buildRecordingCommand.clear(3), 'REC:CLEAR:3');
  assert.equal(buildRecordingCommand.clearAll(), 'REC:CLEAR:ALL');
  assert.equal(buildRecordingCommand.stop(), 'REC:STOP');
  assert.equal(buildRecordingCommand.requestSlots(), 'REC:SLOTS?');
  assert.equal(buildRecordingCommand.validate(), 'REC:VALIDATE?');
});

test('buildRecordingCommand rechaza slots fuera de 1..6', () => {
  assert.throws(() => buildRecordingCommand.start(0), RangeError);
  assert.throws(() => buildRecordingCommand.play(7), RangeError);
  assert.throws(() => buildRecordingCommand.clear(1.5), RangeError);
  assert.equal(RECORDING_SLOT_COUNT, 6);
});

test('buildIdentityCommand', () => {
  assert.equal(buildIdentityCommand.id(), 'ID?');
  assert.equal(buildIdentityCommand.ping(), 'PING');
});

test('parseIncomingLine reconoce mensajes de estado del enlace', () => {
  assert.deepEqual(parseIncomingLine('READY'), { type: 'ready', raw: 'READY' });
  assert.equal(parseIncomingLine('HB:ALIVE').type, 'heartbeat');
  assert.equal(parseIncomingLine('WARN:LINK:LOST').type, 'linkLost');
  assert.equal(parseIncomingLine('INFO:LINK:RESTORED').type, 'linkRestored');
});

test('parseIncomingLine reconoce el identificador del firmware', () => {
  const withPrefix = parseIncomingLine('ID C5HF6U3SBKBB8BSB6KU3-BLE');
  assert.equal(withPrefix.type, 'firmwareId');
  assert.equal(withPrefix.firmwareId, 'C5HF6U3SBKBB8BSB6KU3-BLE');

  const bare = parseIncomingLine('C5HF6U3SBKBB8BSB6KU3-BLE');
  assert.equal(bare.type, 'firmwareGreeting');
  assert.equal(bare.firmwareId, 'C5HF6U3SBKBB8BSB6KU3-BLE');
});

test('parseIncomingLine reconoce el estado de los 6 slots de grabación', () => {
  const result = parseIncomingLine('REC:SLOTS:101000');
  assert.equal(result.type, 'recSlots');
  assert.deepEqual(result.slots, [true, false, true, false, false, false]);
  assert.equal(result.slots.length, 6);
});

test('parseIncomingLine reconoce confirmaciones de grabación por slot', () => {
  assert.deepEqual(parseIncomingLine('REC:STARTED:2'), { type: 'recStarted', slot: 2, raw: 'REC:STARTED:2' });
  assert.deepEqual(parseIncomingLine('REC:STOPPED:2'), { type: 'recStopped', slot: 2, raw: 'REC:STOPPED:2' });
  assert.deepEqual(parseIncomingLine('REC:CLEARED:2'), { type: 'recCleared', slot: 2, raw: 'REC:CLEARED:2' });
  assert.deepEqual(parseIncomingLine('REC:CLEARED:ALL'), { type: 'recClearedAll', raw: 'REC:CLEARED:ALL' });
  assert.deepEqual(parseIncomingLine('REC:PLAYING:5'), { type: 'recPlaying', slot: 5, raw: 'REC:PLAYING:5' });
  assert.deepEqual(parseIncomingLine('REC:PLAYED:5'), { type: 'recPlayed', slot: 5, raw: 'REC:PLAYED:5' });
  assert.deepEqual(parseIncomingLine('REC:EMPTY:4'), { type: 'recEmpty', slot: 4, raw: 'REC:EMPTY:4' });
  assert.equal(parseIncomingLine('REC:FULL').type, 'recFull');
});

test('parseIncomingLine reconoce las 4 combinaciones de REC:VALIDATE?', () => {
  assert.deepEqual(parseIncomingLine('REC:VALID:SAVED'), { type: 'recValidate', valid: true, hasSaved: true, raw: 'REC:VALID:SAVED' });
  assert.deepEqual(parseIncomingLine('REC:VALID:EMPTY'), { type: 'recValidate', valid: true, hasSaved: false, raw: 'REC:VALID:EMPTY' });
  assert.deepEqual(parseIncomingLine('REC:INVALID:SAVED'), { type: 'recValidate', valid: false, hasSaved: true, raw: 'REC:INVALID:SAVED' });
  assert.deepEqual(parseIncomingLine('REC:INVALID:EMPTY'), { type: 'recValidate', valid: false, hasSaved: false, raw: 'REC:INVALID:EMPTY' });
});

test('parseIncomingLine ignora líneas vacías o solo espacios', () => {
  assert.equal(parseIncomingLine(''), null);
  assert.equal(parseIncomingLine('   \n'), null);
  assert.equal(parseIncomingLine(undefined), null);
});

test('parseIncomingLine no lanza excepción con basura / ruido de línea (robustez del enlace BLE)', () => {
  const result = parseIncomingLine('#$%@€💥 basura rara');
  assert.equal(result.type, 'unknown');
  assert.equal(result.raw, '#$%@€💥 basura rara');
});
