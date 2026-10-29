import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { AuthProvider } from '@/modules/auth/context/AuthContext';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

/**
 * The login and register routes answer a refusal with an AppError envelope whose message is English.
 * The screens show the codes they know in the interface language, and the message of any other code
 * as it came.
 */

const envelope = (code: string, message: string) => ({ success: false, error: { code, message } });

function stubAuthApi(path: string, status: number, body: unknown, needsSetup = false) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const reply = url === '/api/auth/status'
      ? { status: 200, body: { needsSetup, isAuthenticated: false } }
      : url === path ? { status, body } : { status: 404, body: { error: 'Not found' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }));
}

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('zh-CN');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

test('a wrong password reads in the interface language', async () => {
  stubAuthApi('/api/auth/login', 401, envelope('AUTH_INVALID_CREDENTIALS', 'Invalid username or password'));
  render(<AuthProvider><LoginForm /></AuthProvider>);

  fireEvent.change(await screen.findByLabelText('用户名'), { target: { value: 'dana' } });
  fill('密码', 'wrong-password');
  fireEvent.click(screen.getByRole('button', { name: '登录' }));

  assert.equal((await screen.findByRole('alert')).textContent, '用户名或密码无效');
});

test('each register refusal the route words reads in the interface language', async () => {
  const refusals: Array<[string, number, string, string]> = [
    ['AUTH_USER_ALREADY_CONFIGURED', 403, 'User already exists. This is a single-user system.', '账户已经存在。这是单用户系统，只能有一个账户。'],
    ['AUTH_USERNAME_CONFLICT', 409, 'Username already exists', '用户名已被占用'],
    ['AUTH_CREDENTIALS_TOO_SHORT', 400, 'Username must be at least 3 characters, password at least 6 characters', '用户名至少 3 个字符，密码至少 6 个字符'],
  ];

  for (const [code, status, message, shown] of refusals) {
    stubAuthApi('/api/auth/register', status, envelope(code, message), true);
    const view = render(<AuthProvider><SetupForm /></AuthProvider>);
    fireEvent.change(await screen.findByLabelText('用户名'), { target: { value: 'dana' } });
    fill('密码', 'dana-pass-123');
    fill('确认密码', 'dana-pass-123');
    fireEvent.click(screen.getByRole('button', { name: '创建账户' }));
    assert.equal((await screen.findByRole('alert')).textContent, shown, code);
    view.unmount();
    vi.unstubAllGlobals();
  }
});

test('a code the screens do not know shows the message it came with', async () => {
  stubAuthApi('/api/auth/login', 429, envelope('AUTH_RATE_LIMITED', 'Too many attempts'));
  render(<AuthProvider><LoginForm /></AuthProvider>);

  fireEvent.change(await screen.findByLabelText('用户名'), { target: { value: 'dana' } });
  fill('密码', 'dana-pass-123');
  fireEvent.click(screen.getByRole('button', { name: '登录' }));

  assert.equal((await screen.findByRole('alert')).textContent, 'Too many attempts');
});
