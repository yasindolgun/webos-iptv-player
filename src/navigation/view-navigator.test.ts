import { describe, expect, it } from 'vitest';
import { ViewNavigator } from './view-navigator';

type View = 'home' | 'channels' | 'player' | 'settings';

describe('ViewNavigator', () => {
  it('pushes distinct destinations and ignores duplicate navigation', () => {
    const navigator = new ViewNavigator<View>('home');

    navigator.navigateTo('channels');
    navigator.navigateTo('channels');
    navigator.navigateTo('player');

    expect(navigator.history).toEqual(['home', 'channels', 'player']);
  });

  it('replaces only the current entry', () => {
    const navigator = new ViewNavigator<View>('home');
    navigator.navigateTo('channels');

    navigator.replaceView('settings');

    expect(navigator.history).toEqual(['home', 'settings']);
  });

  it('resets section navigation to one deterministic root', () => {
    const navigator = new ViewNavigator<View>('home');
    navigator.navigateTo('channels');
    navigator.navigateTo('player');

    navigator.resetTo('settings');

    expect(navigator.history).toEqual(['settings']);
  });

  it('pops history and uses the fallback at the root', () => {
    const navigator = new ViewNavigator<View>('home');
    navigator.navigateTo('channels');

    expect(navigator.goBack('home')).toBe('home');
    expect(navigator.goBack('channels')).toBe('channels');
    expect(navigator.history).toEqual(['channels']);
  });
});
