(() => {
  const ins = [...document.querySelectorAll('input')].filter(i => i.getBoundingClientRect().width > 0);
  if (!ins.length) return 'no-input';
  const i = ins[ins.length - 1];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(i, 'kuaichuan-relay');
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ value: i.value, count: ins.length });
})()