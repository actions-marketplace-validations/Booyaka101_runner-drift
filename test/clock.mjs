/**
 * Preload that moves the wall clock to $RUNNER_DRIFT_TEST_NOW, so CI can prove
 * no test reads it: `node --import ./test/clock.mjs --test`. A test that forgets
 * to pin `now` passes on the day it is written and fails once a fixture date
 * goes by. Without the variable this module does nothing.
 */
const at = process.env.RUNNER_DRIFT_TEST_NOW;
if (at) {
  const RealDate = Date;
  const offset = RealDate.parse(at) - RealDate.now();
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() + offset]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  };
}
