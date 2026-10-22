// Fixed renderer code; no model-authored executable content.
const dialog = document.getElementById('evidence-dialog');
let lastSource;
document.addEventListener('click', event => {
  const button = event.target.closest('[data-evidence]');
  if (!button) return;
  lastSource = button;
  const content = document.getElementById('evidence-content');
  content.replaceChildren();
  document.getElementById('source-reference').textContent = button.dataset.reference;
  for (const id of button.dataset.evidence.split(' ')) {
    const template = document.getElementById('evidence-template-' + id);
    if (template) content.append(template.content.cloneNode(true));
  }
  dialog.showModal();
});
document.getElementById('close-evidence').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => lastSource?.focus());
for (const disclosure of document.querySelectorAll('[data-boolean-state]')) {
  disclosure.addEventListener('toggle', () => {
    for (const peer of document.querySelectorAll('[data-boolean-state]')) {
      if (peer.dataset.booleanState === disclosure.dataset.booleanState && peer.open !== disclosure.open) peer.open = disclosure.open;
    }
  });
}
for (const group of document.querySelectorAll('[data-tabs]')) {
  const list = group.querySelector('[role=tablist]');
  const tabs = [...list.querySelectorAll('[role=tab]')];
  const select = tab => {
    for (const peer of document.querySelectorAll('[data-tabs]')) {
      if (peer.dataset.enumState !== group.dataset.enumState) continue;
      for (const item of peer.querySelector('[role=tablist]').children) {
        const active = item.dataset.stateValue === tab.dataset.stateValue;
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
      }
    }
    tab.focus();
  };
  list.addEventListener('click', e => { const tab = e.target.closest('[role=tab]'); if (tabs.includes(tab)) select(tab); });
  list.addEventListener('keydown', e => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    select(tabs[next]);
  });
}
