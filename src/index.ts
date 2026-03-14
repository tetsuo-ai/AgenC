
function runHeadlessAutopilot() {
  console.log('Starting headless autopilot demo...');
  let state = createInitialState();
  const maxSteps = 1000;
  let steps = 0;
  const scriptedInputs = [
    { thrust: 0.8, turn: 0.5 }, // initial burn and turn towards target
    { thrust: 1.0, turn: 0.0 },
    { thrust: 0.5, turn: -0.2 },
    { thrust: 0.0, turn: 0.0 } // coast
  ];
  let inputIndex = 0;

  while (!state.missionComplete && !state.crashed && !state.fuelExhausted && steps < maxSteps) {
    const input = scriptedInputs[inputIndex % scriptedInputs.length];
    state = deterministicStep(state, input.thrust, input.turn);
    state.time += 1;
    steps++;

    // Check win condition
    const dx = state.ship.position.x - state.missionTarget.x;
    const dy = state.ship.position.y - state.missionTarget.y;
    if (Math.sqrt(dx*dx + dy*dy) < TARGET_DISTANCE) {
      state.missionComplete = true;
      state.score = Math.floor(1000 - steps / 2);
    }

    // Check crash
    if (state.ship.position.y > HEIGHT || Math.abs(state.ship.velocity.x) > 10 || Math.abs(state.ship.velocity.y) > 10) {
      state.crashed = true;
    }

    if (state.ship.fuel <= 0) {
      state.fuelExhausted = true;
    }

    if (steps % 100 === 0) {
      console.log(`Step ${steps}: pos=(${state.ship.position.x.toFixed(1)},${state.ship.position.y.toFixed(1)}), fuel=${state.ship.fuel.toFixed(1)}`);
    }
  }

  if (state.missionComplete) {
    console.log('Mission completed successfully! Score:', state.score);
    process.exit(0);
  } else if (state.crashed) {
    console.log('Ship crashed.');
    process.exit(0);
  } else if (state.fuelExhausted) {
    console.log('Fuel exhausted.');
    process.exit(0);
  } else {
    console.log('Demo timed out.');
    process.exit(0);
  }
}

// Add to main execution
const isHeadless = process.argv.includes('--headless');
if (isHeadless) {
  runHeadlessAutopilot();
} else {
  // existing interactive code
  console.log('Interactive mode not shown in headless phase.');
}
