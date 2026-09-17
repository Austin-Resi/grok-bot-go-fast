async function (action) {
  const field = window.__jevFast?.nodes.get(action.node);
  const autocomplete = action.kind === "fill" && field?.getAttribute("role") === "combobox";
  await new Promise((resolve) => {
    let frames = 0;
    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      resolve();
    };
    setTimeout(finish, autocomplete ? 200 : 50);
    const tick = () => {
      if (stopped) return;
      frames += 1;
      if (!autocomplete && frames >= 2) {
        finish();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
