import { SettingGroup, SettingRow, Switch } from '../ui/index.ts';

export const NETWORK_NOTE = '打开后选手跑的命令能连任何网址，包括这台电脑本身；改了只影响之后派的活';

export function NetworkSettings({ allowed, saving, setAllowed }: {
  allowed: boolean; saving: boolean; setAllowed(on: boolean): void;
}) {
  return <SettingGroup>
    <SettingRow title="允许选手联网" note={NETWORK_NOTE}>
      <Switch label="允许选手联网" checked={allowed} disabled={saving} onChange={setAllowed} />
    </SettingRow>
  </SettingGroup>;
}
