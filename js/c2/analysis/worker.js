/* Worker entry point. The worker is created from a Blob that contains all
 * registered modules (see core/c4.js) and then calls C2.workerMain(self). */
C2.define('workerMain', function (C2) {
  'use strict';

  /** typed arrays of the positions can be transferred instead of copied */
  function transferList(data) {
    const list = [];
    for (const p of Object.values(data.positions)) for (const a of Object.values(p)) list.push(a.buffer);
    if (data.sightJob) for (const j of data.sightJob.kills) list.push(j.segs.buffer);
    if (data.psWeapon) for (const a of Object.values(data.psWeapon)) list.push(a.buffer);
    if (data.psHud) for (const k of ['ammo', 'obj', 'hud']) list.push(data.psHud[k].start.buffer, data.psHud[k].data.buffer);
    return list;
  }

  C2.workerMain = function (scope) {
    scope.onmessage = ev => {
      const { buffer, fileInfo } = ev.data;
      try {
        let last = 0;
        const data = C2.analyzeDemo(new Uint8Array(buffer), fileInfo, frac => {
          if (frac - last >= 0.01 || frac === 1) { last = frac; scope.postMessage({ type: 'progress', value: frac }); }
        });
        scope.postMessage({ type: 'done', data }, transferList(data));
      } catch (err) {
        scope.postMessage({ type: 'error', message: err && err.message ? err.message : String(err),
          invalid: err instanceof C2.demo.DemoError, stack: err && err.stack });
      }
    };
  };
  C2.transferList = transferList;
});
