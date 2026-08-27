// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AccountSwitcher } from './account-switcher';
import type { PlaylistEntry } from '../types';

function account(id: string, name: string): PlaylistEntry {
  return { id, name, url: 'http://host/a', source: 'xtream', xtream: { username: 'u', password: 'p' } };
}

let slot: HTMLElement;
let onSelect: ReturnType<typeof vi.fn>;
let sw: AccountSwitcher;

const A = [account('a1', 'Alpha'), account('a2', 'Bravo'), account('a3', 'Charlie')];

beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div>';
  slot = document.getElementById('slot')!;
  onSelect = vi.fn();
  sw = new AccountSwitcher(slot, { onSelect });
  sw.init();
});

const avatar = () => slot.querySelector<HTMLElement>('.account-avatar');
const menuItems = () => Array.from(slot.querySelectorAll('.account-menu-item'));
const menuOpen = () => !!slot.querySelector('.account-menu');

describe('AccountSwitcher', () => {
  it('is hidden with no accounts', () => {
    sw.setAccounts([], '');
    expect(sw.shown).toBe(false);
    expect(avatar()).toBe(null);
  });

  it('renders the selected account initial and derived color', () => {
    sw.setAccounts(A, 'a2');
    expect(sw.shown).toBe(true);
    expect(avatar()?.textContent).toBe('B');
    expect(avatar()?.getAttribute('style') || '').toContain('hsl(');
  });

  it('opens a menu listing all accounts with the current one marked', () => {
    sw.setAccounts(A, 'a2');
    sw.openMenu();
    expect(sw.menuOpen).toBe(true);
    expect(menuItems().map((n) => n.querySelector('.account-menu-name')?.textContent))
      .toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(slot.querySelector('.account-menu-item.current .account-menu-name')?.textContent).toBe('Bravo');
  });

  it('shows persisted status without rendering credentials', () => {
    sw.setAccounts([{
      id: 'a1',
      name: 'Alpha',
      status: {
        state: 'unreachable',
        expiresAt: null,
        maxConnections: 0,
        activeConnections: 0,
        checkedAt: new Date(2026, 0, 2, 3, 4, 5).getTime(),
      },
    }], 'a1');
    sw.openMenu();

    expect(slot.querySelector('.account-menu-status')?.textContent).toBe('Unreachable');
    expect(slot.querySelector('.account-menu-checked')?.textContent).toContain('Checked');
    expect(slot.innerHTML).not.toContain('password');
  });

  it('down/up move the highlighted row; select fires onSelect and closes', () => {
    sw.setAccounts(A, 'a1'); // highlight starts on the current row (index 0)
    sw.openMenu();
    sw.handleAction('down'); // -> a2
    expect(slot.querySelector('.account-menu-item.focused .account-menu-name')?.textContent).toBe('Bravo');
    // Test up wrap-around: from index 0 (a1) to last row (a3/Charlie)
    sw.setAccounts(A, 'a1');
    sw.openMenu();
    sw.handleAction('up'); // wraps from index 0 to index 2
    expect(slot.querySelector('.account-menu-item.focused .account-menu-name')?.textContent).toBe('Charlie');
    // Test select fires onSelect and closes
    sw.handleAction('select');
    expect(onSelect).toHaveBeenCalledWith('a3');
    expect(sw.menuOpen).toBe(false);
  });

  it('choosing the already-current account closes without firing onSelect', () => {
    sw.setAccounts(A, 'a1');
    sw.openMenu();
    sw.handleAction('select'); // highlight is on a1 (current)
    expect(onSelect).not.toHaveBeenCalled();
    expect(sw.menuOpen).toBe(false);
  });

  it('back/left close the menu without selecting', () => {
    sw.setAccounts(A, 'a1');
    sw.openMenu();
    sw.handleAction('back');
    expect(sw.menuOpen).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    // Test that left also closes
    sw.openMenu();
    sw.handleAction('left');
    expect(sw.menuOpen).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a pointer click on a row selects that account', () => {
    sw.setAccounts(A, 'a1');
    sw.openMenu();
    const row = menuItems()[2] as HTMLElement; // Charlie
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => row;
    document.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }));
    document.elementFromPoint = orig;
    expect(onSelect).toHaveBeenCalledWith('a3');
    expect(sw.menuOpen).toBe(false);
  });

  it('a pointer click on the avatar toggles the menu', () => {
    sw.setAccounts(A, 'a1');
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => avatar()!;
    document.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5, bubbles: true }));
    expect(menuOpen()).toBe(true);
    document.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5, bubbles: true }));
    expect(menuOpen()).toBe(false);
    document.elementFromPoint = orig;
  });

  it('pointer hover moves the highlight onto the hovered row; OK then picks it', () => {
    sw.setAccounts(A, 'a1'); // opens highlighting the current row (a1)
    sw.openMenu();
    // Hover Charlie (dispatch on a child to exercise the closest() lookup).
    slot.querySelector('.account-menu-item[data-account-id="a3"] .account-menu-name')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(slot.querySelector('.account-menu-item.focused .account-menu-name')?.textContent).toBe('Charlie');
    sw.handleAction('select'); // OK selects the hovered row
    expect(onSelect).toHaveBeenCalledWith('a3');
  });

  it('single account still opens a one-row menu; choosing it is a no-op close', () => {
    sw.setAccounts([account('a1', 'Alpha')], 'a1');
    sw.openMenu();
    expect(menuItems().length).toBe(1);
    sw.handleAction('select');
    expect(onSelect).not.toHaveBeenCalled();
    expect(sw.menuOpen).toBe(false);
  });

  it('setFocused toggles the avatar focus ring', () => {
    sw.setAccounts(A, 'a1');
    sw.setFocused(true);
    expect(avatar()?.classList.contains('focused')).toBe(true);
    sw.setFocused(false);
    expect(avatar()?.classList.contains('focused')).toBe(false);
  });
});
