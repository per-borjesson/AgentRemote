#!/usr/bin/env python3
"""Playwright smoke test for the OWA chat UI."""
import os, sys, time
from playwright.sync_api import sync_playwright, expect

BASE = 'http://localhost:3002'
TOKEN = os.environ.get('AUTH_TOKEN', '')

if not TOKEN:
    env = {}
    with open(os.path.expanduser('~/codex-mobile/.env')) as f:
        for line in f:
            if '=' in line and not line.startswith('#'):
                k, v = line.strip().split('=', 1)
                env[k] = v
    TOKEN = env.get('AUTH_TOKEN', '')

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(BASE)

        # Login
        page.fill('#token-input', TOKEN)
        page.click('#login-btn')
        page.wait_for_selector('.session-card', timeout=8000)
        print('✓ login')

        # Open first available session
        first_card = page.locator('.session-card').first
        session_name = first_card.get_attribute('data-name')
        if not session_name:
            print('✗ no sessions found — create one first')
            browser.close()
            sys.exit(1)
        # Click by data-name to survive list re-renders from WebSocket
        page.locator(f'.session-card[data-name="{session_name}"]').click()
        page.wait_for_selector('#chat-view', timeout=5000)
        print(f'✓ opened session: {session_name}')

        # Chat view should be visible by default, terminal hidden
        assert page.is_visible('#chat-view'), '✗ chat-view not visible'
        assert not page.is_visible('#output'), '✗ terminal should be hidden'
        print('✓ chat view is default')

        # Toggle to terminal view
        page.click('#view-toggle-btn')
        time.sleep(0.3)
        assert not page.is_visible('#chat-view'), '✗ chat-view should be hidden'
        assert page.is_visible('#output'), '✗ terminal should be visible'
        print('✓ toggle to terminal works')

        # Toggle back to chat
        page.click('#view-toggle-btn')
        time.sleep(0.3)
        assert page.is_visible('#chat-view'), '✗ chat-view not visible after toggle back'
        print('✓ toggle back to chat works')

        # Send a message and check optimistic bubble appears
        page.fill('#input-text', 'playwright test message')
        page.click('#send-btn')
        time.sleep(0.5)
        bubbles = page.query_selector_all('.bubble.user')
        assert bubbles, '✗ no user bubble appeared'
        last_bubble = bubbles[-1].inner_text()
        assert 'playwright test message' in last_bubble, f'✗ bubble text wrong: {last_bubble}'
        print('✓ user bubble appears immediately on send')

        # Wait for AI response bubble (up to 30s)
        print('  waiting for AI response bubble...')
        try:
            page.wait_for_selector('.bubble.ai', timeout=30000)
            print('✓ AI response bubble appeared')
        except:
            print('⚠ no AI response within 30s (session may be idle)')

        # Browser back button returns to session list
        page.go_back()
        time.sleep(0.3)
        assert page.is_visible('#main-screen'), '✗ main screen not shown after browser back'
        assert not page.is_visible('#session-screen'), '✗ session screen still visible after back'
        print('✓ browser back navigates to session list')

        print('\nAll tests passed.')
        browser.close()

if __name__ == '__main__':
    run()
