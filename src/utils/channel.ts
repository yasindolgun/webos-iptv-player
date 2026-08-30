import { UNCATEGORIZED_GROUP } from '../types';
import { t } from '../i18n';

export {
  channelKey,
  legacyChannelKey,
  stableStreamUrl,
} from './channel-key';

// Only the synthetic ungrouped bucket is localized — provider names are data.
export function groupDisplayLabel(group: string): string {
  return group === UNCATEGORIZED_GROUP ? t('channel.uncategorized') : group;
}
