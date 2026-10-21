import { useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { useApi } from '@hostwerk/api';
import { Tabs } from '@hostwerk/ui';
import { ExtTabView, extIcon } from '@hostwerk/kit';

/*
 * Reiter anderer Erweiterungen (manifest „allowExtensions“: { "*": ["tabs"] }). Bei nativen Seiten zeichnet Hostwerk
 * die Reiter von Zusätzen nicht selbst – die Seite holt sie aus ext.extendedBy und zeigt sie abgeschottet (ExtTabView,
 * mit den Rechten des Zusatzes, nie mit unseren).
 */
export function useAddonTabs(ext) {
  const m = useApi('/extmarket', [], { live: false, poll: true });
  const lang = document.documentElement.lang === 'en' ? 'en' : 'de';
  const installed = (m.data && m.data.installed) || [];
  return ((ext && ext.extendedBy) || []).flatMap((b) => {
    const x = installed.find((e) => e.id === b.id && !e.error);
    return x ? (b.tabs || []).map((tab) => ({ id: `x-${b.id}-${tab.id}`, label: (tab.titles && tab.titles[lang]) || tab.id, icon: extIcon(tab.icon || (x.page && x.page.icon)), ext: x, tab })) : [];
  });
}

/** Inhalt mit Reiterleiste „Overview“ + Reiter der Zusätze – ohne Zusätze nur der Inhalt selbst. */
export function AddonTabs({ ext, children }) {
  const tabs = useAddonTabs(ext);
  const [cur, setCur] = useState('main');
  if (!tabs.length) return children;
  const item = tabs.find((x) => x.id === cur);
  return (
    <>
      <Tabs value={item ? cur : 'main'} onChange={setCur} tabs={[{ id: 'main', label: 'Overview', icon: LayoutDashboard }, ...tabs.map((x) => ({ id: x.id, label: x.label, icon: x.icon }))]} />
      {item ? <ExtTabView key={item.id} item={item} kind="ext" id={ext.id} /> : children}
    </>
  );
}
