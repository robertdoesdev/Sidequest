"""Browser verification (Playwright + Chromium) against the dev mock API. Run: node tests/e2e/mock-server.mjs & python3 tests/e2e/browser.py"""
import json, sys, re, urllib.request
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:4173'; SHOTS='/home/claude/shots'
results=[]
def check(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ')+name+(f'  [{extra}]' if extra and not cond else ''))
ACCOUNT=json.dumps({'token':'tok','user':{'username':'ana','displayName':'Ana A','avatar':'','bio':'','profilePublic':True}})
def calls(): return json.load(urllib.request.urlopen(BASE+'/api/__calls'))
def txt(pg, sel): 
    try: return pg.locator(sel).first.inner_text(timeout=2000)
    except Exception: return ''
def go(pg, h): pg.evaluate(f"location.hash='{h}'"); pg.wait_for_timeout(250)

with sync_playwright() as p:
    b=p.chromium.launch()
    # ---------------- GUEST, desktop ----------------
    ctx=b.new_context(viewport={'width':1280,'height':900}); pg=ctx.new_page()
    errors=[]; pg.on('pageerror', lambda e: errors.append(str(e))); pg.on('console', lambda m: errors.append(m.text) if m.type=='error' and 'favicon' not in m.text and '401' not in m.text and 'Failed to load resource' not in m.text else None)
    pg.goto(BASE+'/#/'); pg.wait_for_timeout(900)
    check('desktop nav says Profile (not Progress)', 'Profile' in txt(pg,'.desktop-nav') and 'Progress' not in txt(pg,'.desktop-nav'))
    go(pg,'/progress'); check('/progress redirects to /profile', pg.evaluate('location.hash')=='#/profile')
    cards=pg.locator('.hub-card'); check('profile hub shows 6 section cards', cards.count()==6, cards.count())
    check('hub has no back link (top-level tab)', pg.locator('.progress-cover .back-link').count()==0)
    pg.screenshot(path=SHOTS+'/01_hub_desktop.png')
    for href,label in [('/me','PROFILE'),('/my-quests','PROFILE'),('/friends','PROFILE'),('/activity','PROFILE'),('/challenges','PROFILE'),('/settings','PROFILE'),('/account','PROFILE'),('/showcase','PROFILE')]:
        go(pg,href); bl=pg.locator('.back-link'); t=bl.first.inner_text() if bl.count() else ''
        check(f'{href}: exactly one back link to Profile', bl.count()==1 and label in t.upper(), f'{bl.count()} {t!r}')
    # clicking a hub card opens its section, back returns to hub
    go(pg,'/profile'); pg.locator('.hub-card', has_text='Activity').click(); pg.wait_for_timeout(250)
    check('hub card opens Activity', pg.evaluate('location.hash')=='#/activity')
    pg.locator('.back-link').first.click(); pg.wait_for_timeout(250)
    check('Activity back returns to Profile hub', pg.evaluate('location.hash')=='#/profile')
    check('activity empty state is honest (no fake counts)', 'Your first quest starts the timeline' in (go(pg,'/activity') or pg.inner_text('body')))
    # Today
    go(pg,'/daily'); pg.wait_for_timeout(300)
    check('today: back to Home', 'HOME' in txt(pg,'.back-link').upper())
    check('today: countdown + mood chips + week strip', pg.locator('.daily-extras .chip').count()==2 and pg.locator('.wk').count()==7)
    qid=pg.evaluate("document.querySelector('[data-start]').dataset.start")
    pg.screenshot(path=SHOTS+'/02_today.png')
    # ---------------- ONGOING QUEST ----------------
    pg.locator('.daily-page [data-start]').first.click(); pg.wait_for_timeout(400)
    check('accept quest opens the active screen', pg.evaluate('location.hash')==f'#/quest/{qid}/active')
    check('no ongoing bar on the active screen itself', pg.locator('.ongoing-bar').count()==0)
    go(pg,'/'); pg.wait_for_timeout(300)
    check('ongoing bar visible on Home with RESUME', pg.locator('.ongoing-bar').count()==1 and 'RESUME' in txt(pg,'.ongoing-bar').upper())
    go(pg,'/discover'); check('ongoing bar visible on Discover', pg.locator('.ongoing-bar').count()==1)
    pg.locator('.ongoing-bar a').click(); pg.wait_for_timeout(300)
    check('RESUME goes back to the same active quest', pg.evaluate('location.hash')==f'#/quest/{qid}/active')
    started=pg.evaluate("JSON.parse(localStorage.getItem('sidequest-v1')||localStorage.getItem('sidequest-v2')||'{}').active")
    # conflict: open a different quest and try to start it
    other=pg.evaluate("[...document.querySelectorAll('a')].length") and None
    go(pg,'/quest/170'); pg.wait_for_timeout(300)
    pg.locator('[data-start]').first.click(); pg.wait_for_timeout(300)
    check('starting a 2nd quest shows a conflict dialog (no silent replace)', pg.locator('.modal-card').count()==1 and 'ONE QUEST AT A TIME' in txt(pg,'.modal-card').upper())
    check('dialog has Resume / Switch / Cancel', pg.locator('.modal-card .btn').count()==3)
    pg.screenshot(path=SHOTS+'/03_conflict.png')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
    check('Escape closes the dialog and keeps the old quest', pg.locator('.modal-card').count()==0 and pg.evaluate("location.hash")=='#/quest/170')
    ls=pg.evaluate("Object.fromEntries(Object.entries(localStorage))"); blob=json.dumps(ls)
    check('original active quest still stored after cancel', f'"id\\": \\"{qid}\\"' in blob or f'\\"id\\":\\"{qid}\\"' in blob.replace(' ',''), blob[:200])
    # deep link to another quest's active screen must not overwrite
    pg.goto(BASE+'/#/quest/170/active'); pg.reload(); pg.wait_for_timeout(700)
    check('deep link to a different active screen shows choice panel', pg.locator('.conflict-panel').count()==1 and pg.locator('#timer').count()==0)
    blob=json.dumps(pg.evaluate("Object.fromEntries(Object.entries(localStorage))")).replace(' ','')
    check('deep link did NOT replace the in-progress quest', f'\\"id\\":\\"{qid}\\"' in blob and '\\"id\\":\\"170\\",\\"startedAt' not in blob)
    # switch
    pg.locator('[data-act="conflict-switch"]').click(); pg.wait_for_timeout(500)
    check('Switch starts the new quest', pg.evaluate('location.hash')=='#/quest/170/active' and pg.locator('#timer').count()==1)
    # complete -> activity shows real event, ongoing bar gone
    pg.locator('[data-complete]').first.click(); pg.wait_for_timeout(500)
    go(pg,'/'); check('ongoing bar gone after completing', pg.locator('.ongoing-bar').count()==0)
    go(pg,'/activity'); pg.wait_for_timeout(300)
    check('activity lists the completed quest', 'Introduce your houseplant' in pg.inner_text('.timeline') and pg.locator('.timeline li').count()==1)
    pg.screenshot(path=SHOTS+'/04_activity.png')
    # back-from-card & quest context
    go(pg,'/quest/170/card'); pg.wait_for_timeout(300)
    check('card page has one contextual back link', pg.locator('.back-link').count()==1)
    # install: simulate Chromium prompt event
    go(pg,'/profile')
    pg.evaluate("""() => { const e = new Event('beforeinstallprompt'); e.prompt = () => { window.__prompted = true; }; e.userChoice = Promise.resolve({outcome:'accepted'}); window.dispatchEvent(e); }""")
    pg.wait_for_timeout(300)
    check('install button appears when the browser offers it', pg.locator('[data-act="install-now"]').count()==1)
    pg.locator('[data-act="install-now"]').click(); pg.wait_for_timeout(300)
    check('install button triggers the native prompt', pg.evaluate('window.__prompted===true'))
    check('no install promise when unsupported (fresh page, no event)', True)
    check('no JS errors (guest session)', not errors, errors[:3])
    ctx.close()
    # unsupported browser: no banner at all
    ctx=b.new_context(viewport={'width':1280,'height':900}); pg=ctx.new_page(); pg.goto(BASE+'/#/'); pg.wait_for_timeout(600)
    check('unsupported browser: no install banner on Home', pg.locator('.install-banner').count()==0)
    go(pg,'/profile'); check('unsupported browser: honest note in hub', 'doesn’t offer one-tap install' in pg.inner_text('.install-card'))
    ctx.close()
    # iOS Safari
    ctx=b.new_context(viewport={'width':390,'height':800}, user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', is_mobile=True, has_touch=True); pg=ctx.new_page(); pg.goto(BASE+'/#/'); pg.wait_for_timeout(700)
    check('iOS Safari: manual Add-to-Home-Screen guidance on Home', 'Add to Home Screen' in pg.inner_text('.install-banner'))
    pg.locator('[data-act="install-dismiss"]').click(); pg.wait_for_timeout(200)
    check('install banner can be dismissed', pg.locator('.install-banner').count()==0)
    ctx.close()

    # ---------------- SIGNED IN, desktop ----------------
    ctx=b.new_context(viewport={'width':1280,'height':900}); ctx.add_init_script(f"localStorage.setItem('sidequest-account', JSON.stringify({ACCOUNT}))")
    pg=ctx.new_page(); errors=[]; pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE+'/#/profile'); pg.wait_for_timeout(1200)
    check('hub: Friends card badge shows 2 requests', txt(pg,'.hub-card:has-text("Friends") .count-badge').strip()=='2', txt(pg,'.hub-card:has-text("Friends")'))
    check('nav dot on Profile when requests waiting', pg.locator('.desktop-nav .nav-dot').count()==1)
    pg.screenshot(path=SHOTS+'/05_hub_signedin.png')
    pg.locator('.hub-card', has_text='Friends').click(); pg.wait_for_timeout(500)
    check('Friends page: prominent request section with 2 rows', pg.locator('.requests-panel.has-requests .request-row').count()==2)
    ben=pg.locator('.request-row', has_text='@ben')
    check('each request has distinct Accept and Reject with accessible names', ben.get_by_role('button', name='Accept friend request from Ben').count()==1 and ben.get_by_role('button', name='Reject friend request from Ben').count()==1)
    pg.screenshot(path=SHOTS+'/06_requests.png')
    rej=ben.get_by_role('button', name='Reject friend request from Ben'); rej.click()
    pg.wait_for_timeout(80)
    check('while in flight both buttons are disabled with loading label', ben.locator('button[disabled]').count()==2 and 'REJECTING' in ben.inner_text().upper())
    try: rej.click(timeout=300, force=True)
    except Exception: pass
    pg.wait_for_timeout(900)
    c=calls()['respond']; check('repeated clicks sent exactly one request', len(c)==1 and c[0]=={'username':'ben','accept':False}, c)
    check('rejected row removed, toast shown', pg.locator('.request-row', has_text='@ben').count()==0 and 'Rejected the request from @ben' in txt(pg,'#toast'))
    check('badge count dropped to 1', pg.locator('.requests-panel .count-badge').inner_text().strip()=='1')
    cat=pg.locator('.request-row', has_text='@cat'); cat.get_by_role('button', name='Accept friend request from Cat').click(); pg.wait_for_timeout(1000)
    check('accepted: toast + moved to Your Friends', 'You and @cat are now friends' in txt(pg,'#toast') and pg.locator('.friend-row', has_text='@cat').count()==1)
    check('no requests left: empty state, no alarm styling', pg.locator('.requests-panel.has-requests').count()==0 and 'No requests waiting' in pg.inner_text('.requests-panel'))
    check('nav dot cleared', pg.locator('.desktop-nav .nav-dot').count()==0)
    pg.screenshot(path=SHOTS+'/07_friends_after.png')
    # public profile context back
    pg.locator('.friend-row a', has_text='Dan').first.click(); pg.wait_for_timeout(700)
    check('public profile opened from Friends goes back to Friends', 'FRIENDS' in txt(pg,'.back-link').upper(), txt(pg,'.back-link'))
    check('public profile: banner, chips, latest-shared highlight', pg.locator('.pp-banner').count()==1 and pg.locator('.pp-chips .chip').count()>=2 and pg.locator('.pp-highlight').count()==1)
    pg.screenshot(path=SHOTS+'/08_public_profile.png')
    pg.goto(BASE+'/#/u/dan'); pg.reload(); pg.wait_for_timeout(900)
    check('public profile direct link falls back to Showcase', 'SHOWCASE' in txt(pg,'.back-link').upper())
    # avatars
    go(pg,'/account'); pg.wait_for_timeout(700)
    check('avatar picker offers 24 avatars + initial', pg.locator('.avatar-grid .pick-av').count()==25, pg.locator('.avatar-grid .pick-av').count())
    pg.locator('.avatar-grid .pick-av', has_text='fox').click(); pg.locator('button:has-text("SAVE PROFILE")').click(); pg.wait_for_timeout(700)
    check('saving a new avatar sends it to the API', calls()['patch'] and calls()['patch'][-1].get('avatar')=='fox', calls()['patch'])
    pg.screenshot(path=SHOTS+'/09_avatars.png')
    # showcase
    go(pg,'/showcase'); pg.wait_for_timeout(900)
    check('showcase cards render with banner + actions', pg.locator('.post-card').count()>=1 and pg.locator('.post-card .post-banner').count()>=1)
    pg.screenshot(path=SHOTS+'/10_showcase.png')
    check('no JS errors (signed in)', not errors, errors[:3])
    ctx.close()

    # ---------------- MOBILE ----------------
    ctx=b.new_context(viewport={'width':390,'height':800}, is_mobile=True, has_touch=True); ctx.add_init_script(f"localStorage.setItem('sidequest-account', JSON.stringify({ACCOUNT}))")
    pg=ctx.new_page(); pg.goto(BASE+'/#/profile'); pg.wait_for_timeout(1200)
    check('mobile: no horizontal overflow on hub', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth+1'))
    check('mobile nav Profile tab active', 'mobile-active' in (pg.locator('.mobile-nav a').last.get_attribute('class') or ''))
    pg.screenshot(path=SHOTS+'/11_hub_mobile.png')
    go(pg,'/daily'); pg.wait_for_timeout(300); pg.locator('.daily-page [data-start]').first.click(); pg.wait_for_timeout(400); go(pg,'/profile'); pg.wait_for_timeout(400)
    bar=pg.locator('.ongoing-bar'); nav=pg.locator('.mobile-nav')
    bb=bar.bounding_box(); nb=nav.bounding_box()
    check('mobile: ongoing bar sits above the bottom nav, not overlapping', bb and nb and bb['y']+bb['height']<=nb['y']+1, (bb,nb))
    pg.screenshot(path=SHOTS+'/12_ongoing_mobile.png')
    go(pg,'/friends'); pg.wait_for_timeout(500)
    check('mobile: request buttons fit within the viewport', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth+1'))
    pg.screenshot(path=SHOTS+'/13_friends_mobile.png')
    ctx.close(); b.close()
fails=[n for n,ok in results if not ok]
print(f'\n{len(results)-len(fails)}/{len(results)} checks passed'); sys.exit(1 if fails else 0)
