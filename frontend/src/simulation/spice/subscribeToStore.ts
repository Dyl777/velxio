/**
 * subscribeToStore — legacy solve loop driver.
 *
 * Subscribes to `useSimulatorStore` for canvas changes and to a
 * 200 ms timer while any board runs.  Builds the SPICE netlist via
 * `buildInputFromStore` and pushes it to the legacy CircuitScheduler
 * via `useElectricalStore.triggerSolve(input)`.
 *
 * Scope today (Phase 1c step C):
 *   - Solve loop ONLY.
 *   - The ADC injection / waveform replay / ESP32 QEMU push was
 *     extracted into `connectAnalogInputsToMcu.ts` so the new
 *     CircuitSimulationService (which fills useElectricalStore from
 *     the WASM path) can share the same downstream consumer.
 *
 * Lifetime: this file will be DELETED in Phase 1c step G1 once the
 * service is the default and the feature flag goes away.  Until
 * then it keeps the legacy behaviour alive behind the flag.
 */
import {
  useSimulatorStore,
  getBoardPinManager,
} from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { buildInputFromStore } from './storeAdapter';
import type { PinSourceState } from './types';
import type { BoardKind } from '../../types/board';
import { BOARD_PIN_GROUPS } from './boardPinGroups';

/**
 * Convert a board pin name (e.g. "9", "A0", "GP26", "GPIO32") to the
 * Arduino-style pin number that PinManager uses internally.
 * Returns -1 if the name doesn't map to a GPIO pin.
 */
function pinNameToArduinoPin(pinName: string, boardKind: BoardKind): number {
  const group = BOARD_PIN_GROUPS[boardKind] ?? BOARD_PIN_GROUPS.default;
  if (group.gnd.includes(pinName) || group.vcc_pins.includes(pinName)) return -1;
  if (pinName.startsWith('GP')) {
    const n = parseInt(pinName.slice(2), 10);
    return Number.isFinite(n) ? n : -1;
  }
  if (pinName.startsWith('GPIO')) {
    const n = parseInt(pinName.slice(4), 10);
    return Number.isFinite(n) ? n : -1;
  }
  if (/^A\d+$/.test(pinName)) {
    return 14 + parseInt(pinName.slice(1), 10);
  }
  if (/^\d+$/.test(pinName)) {
    return parseInt(pinName, 10);
  }
  return -1;
}

/**
 * Collect MCU output pin states from PinManager for pins that participate
 * in the circuit (i.e., are referenced by wires).
 *
 * Exported so the CircuitSimulationService can reuse the same per-board
 * pin-number mapping without copying it.
 */
export function collectPinStates(
  boardId: string,
  boardKind: BoardKind,
  wires: Array<{
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
  }>,
): Record<string, PinSourceState> {
  const pm = getBoardPinManager(boardId);
  if (!pm) return {};
  const group = BOARD_PIN_GROUPS[boardKind] ?? BOARD_PIN_GROUPS.default;
  const vcc = group.vcc;

  const result: Record<string, PinSourceState> = {};
  const pinNames = new Set<string>();
  for (const w of wires) {
    if (w.start.componentId === boardId) pinNames.add(w.start.pinName);
    if (w.end.componentId === boardId) pinNames.add(w.end.pinName);
  }

  for (const pinName of pinNames) {
    const arduinoPin = pinNameToArduinoPin(pinName, boardKind);
    if (arduinoPin < 0) continue;
    const pwmDuty = pm.getPwmValue(arduinoPin);
    if (pwmDuty > 0) {
      result[pinName] = { type: 'pwm', duty: pwmDuty };
    } else if (pm.getPinState(arduinoPin)) {
      result[pinName] = { type: 'digital', v: vcc };
    }
  }
  return result;
}

export function wireElectricalSolver(): () => void {
  let lastInputJson = '';

  function maybeSolve() {
    const storeState = useSimulatorStore.getState();
    const snap = {
      components: storeState.components,
      wires: storeState.wires,
      boards: storeState.boards.map((b) => ({
        id: b.id,
        boardKind: b.boardKind,
        pinStates: collectPinStates(b.id, b.boardKind, storeState.wires),
      })),
    };
    const input = buildInputFromStore(snap);

    const inputJson = JSON.stringify(input);
    if (inputJson === lastInputJson) return;
    lastInputJson = inputJson;

    useElectricalStore.getState().triggerSolve(input);
  }

  // Re-solve on components / wires changes.
  const unsubSim = useSimulatorStore.subscribe((state, prev) => {
    if (state.components !== prev.components || state.wires !== prev.wires) {
      maybeSolve();
    }
  });

  // Initial solve.
  maybeSolve();

  // Periodic re-solve while any board is running, so SPICE picks up
  // MCU pin-state changes (e.g. analogWrite → PWM → voltage source).
  let solveInterval: ReturnType<typeof setInterval> | null = null;
  const SOLVE_INTERVAL_MS = 200;

  function updateSolveTimer() {
    const anyRunning = useSimulatorStore.getState().boards.some((b) => b.running);
    if (anyRunning) {
      if (!solveInterval) {
        solveInterval = setInterval(maybeSolve, SOLVE_INTERVAL_MS);
      }
    } else if (solveInterval) {
      clearInterval(solveInterval);
      solveInterval = null;
    }
  }

  const unsubRunning = useSimulatorStore.subscribe((state, prev) => {
    const wasRunning = prev.boards.some((b) => b.running);
    const nowRunning = state.boards.some((b) => b.running);
    if (wasRunning !== nowRunning) updateSolveTimer();
  });

  return () => {
    unsubSim();
    unsubRunning();
    if (solveInterval) clearInterval(solveInterval);
  };
}
