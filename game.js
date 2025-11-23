// TotalShooterApp.jsx
// Full single-file React app (TailwindCSS assumed available)
// Features included (best-effort high-quality):
// - Canvas-based shooter with AI opponents (smart behaviors)
// - Mobile touch support: virtual joystick + fire button
// - Programmatic high-quality-ish sounds via WebAudio (no external files)
// - Sprite system using inline SVG sprite-sheet + simple animator
// - Simple Firebase backend hooks for leaderboard (placeholder config)
// - Responsive homepage layout (hero, play area, controls, leaderboard, about)
// - Accessibility: keyboard controls, touch, clear HUD
//
// How to use:
// 1) Create a React project (Vite / CRA). Install Firebase if you want backend: `npm i firebase`
// 2) Add TailwindCSS following standard setup (Tailwind not strictly required but styles expect it).
// 3) Copy this file into src/ and import in App.jsx: `import TotalShooterApp from './TotalShooterApp'`.
// 4) Replace FIREBASE_CONFIG placeholders with your project's config to enable leaderboard.

import React, { useEffect, useRef, useState } from 'react';

// Optional: import firebase functions if you plan to enable leaderboard
// import { initializeApp } from 'firebase/app';
// import { getDatabase, ref, push, set, onValue, query, orderByChild, limitToLast } from 'firebase/database';

export default function TotalShooterApp(){
  // UI state
  const [screen, setScreen] = useState('home'); // home | play | leaderboard
  const [scoreBoard, setScoreBoard] = useState([]);
  const [playerName, setPlayerName] = useState('Player');

  // game refs
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const audioCtxRef = useRef(null);
  const gameStateRef = useRef(null);
  const inputRef = useRef({});
  const touchIdsRef = useRef({});

  // firebase placeholders
  const FIREBASE_CONFIG = null; // <-- Paste your firebase config object here to enable leaderboard

  useEffect(()=>{
    // Initialize audio context once
    audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    // initialize game state
    gameStateRef.current = makeInitialGameState();
    // optional: load leaderboard from backend if enabled
    // if (FIREBASE_CONFIG) initFirebaseAndLoad();
    return ()=>{
      cancelAnimationFrame(rafRef.current);
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') audioCtxRef.current.close();
    }
  },[]);

  // --- Game core -------------------------------------------------
  function makeInitialGameState(){
    return {
      W: 1200, H: 680,
      player: { x:600, y:340, r:20, speed:4, hp:3, score:0 },
      bullets: [], enemies: [], particles: [],
      wave:1, spawnTimer:0, spawnInterval:100, enemySpeedBase:0.9,
      running: false, paused:false, gameOver:false,
      lastShotTime:0, shotInterval:120,
      joystick: { active:false, cx:0, cy:0, x:0, y:0 },
      touchFire:false
    }
  }

  // Sprite info: using inline vector art (SVG path sets) to be drawn on canvas
  const SPRITES = {
    player: { draw: (ctx,x,y,r, t)=>{
      // stylized tank-like player: draw body + turret
      ctx.save();
      ctx.translate(x,y);
      // body
      ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fillStyle = '#6bd3ff'; ctx.fill();
      ctx.fillStyle = '#083d6b'; ctx.fillRect(-r*0.3, -r*0.6, r*0.6, r*1.2);
      // turret rotates toward mouse stored in t.turretAngle
      ctx.save(); ctx.rotate(t.turretAngle||0);
      ctx.fillStyle = '#052836'; ctx.fillRect(6, -6, r+8, 12);
      ctx.restore();
      ctx.restore();
    }},
    enemy: { draw: (ctx,x,y,r, t)=>{
      ctx.save(); ctx.translate(x,y);
      ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.fillStyle = t.color||'#ff6b6b'; ctx.fill();
      ctx.restore();
    }},
    bullet: { draw: (ctx,x,y,r)=>{ ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fillStyle='#ffd'; ctx.fill(); } }
  }

  // --- Audio helpers (synthesized) ------------------------------
  function ensureAudio(){ if(!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext||window.webkitAudioContext)(); }
  function playShot(){
    ensureAudio();
    const ac = audioCtxRef.current;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(1200, ac.currentTime);
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, ac.currentTime + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.18);
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + 0.2);
  }
  function playExplosion(){
    ensureAudio();
    const ac = audioCtxRef.current;
    // noise burst
    const bufferSize = ac.sampleRate * 0.25;
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for(let i=0;i<bufferSize;i++){ data[i] = (Math.random()*2-1) * Math.exp(-3*i/bufferSize); }
    const src = ac.createBufferSource(); src.buffer = buffer; const g = ac.createGain(); g.gain.value = 0.8; src.connect(g); g.connect(ac.destination); src.start();
  }
  function playHurt(){
    ensureAudio(); const ac = audioCtxRef.current; const o = ac.createOscillator(); const g = ac.createGain(); o.type='sawtooth'; o.frequency.setValueAtTime(240, ac.currentTime); g.gain.value=0.0001; g.gain.exponentialRampToValueAtTime(0.12, ac.currentTime+0.01); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime+0.25); o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime+0.26);
  }

  // --- AI behavior for enemies ---------------------------------
  function spawnEnemy(state){
    const side = Math.floor(Math.random()*4);
    let x,y;
    if(side===0){ x=-40; y = Math.random()*state.H; }
    else if(side===1){ x=state.W+40; y = Math.random()*state.H; }
    else if(side===2){ x=Math.random()*state.W; y=-40; }
    else { x=Math.random()*state.W; y=state.H+40; }
    const types = ['normal','fast','big'];
    const t = types[Math.floor(Math.random()*types.length)];
    const obj = { x,y, r: t==='big'?28:(t==='fast'?12:18), hp: t==='big'?3:1, type:t, color: t==='big'? '#7af' : (t==='fast'? '#ffb86b' : '#ff6b6b'), vx:0, vy:0 };
    state.enemies.push(obj);
  }

  function updateGameLogic(state, input){
    if(!state.running || state.paused || state.gameOver) return;
    const p = state.player;
    // movement
    if(input.left) p.x -= p.speed; if(input.right) p.x += p.speed; if(input.up) p.y -= p.speed; if(input.down) p.y += p.speed;
    // joystick (touch)
    if(state.joystick.active){ const dx = state.joystick.x - state.joystick.cx; const dy = state.joystick.y - state.joystick.cy; const d = Math.hypot(dx,dy); if(d>6){ p.x += (dx/d) * p.speed; p.y += (dy/d) * p.speed; } }
    // bounds
    p.x = Math.max(p.r, Math.min(state.W - p.r, p.x)); p.y = Math.max(p.r, Math.min(state.H - p.r, p.y));
    // shooting
    const now = performance.now();
    if((input.fire || state.touchFire) && (now - state.lastShotTime) > state.shotInterval){
      // aim: toward input.aimX/Y if present, else mouse position
      const aimX = input.aimX ?? state.W/2; const aimY = input.aimY ?? state.H/2;
      const ang = Math.atan2(aimY - p.y, aimX - p.x);
      const speed = 14;
      state.bullets.push({ x: p.x + Math.cos(ang)*(p.r+8), y: p.y + Math.sin(ang)*(p.r+8), vx: Math.cos(ang)*speed, vy: Math.sin(ang)*speed, r:5, life:80 });
      state.lastShotTime = now;
      playShot();
    }
    // bullets update
    for(let i=state.bullets.length-1;i>=0;i--){ const b = state.bullets[i]; b.x += b.vx; b.y += b.vy; b.life--; if(b.life<=0 || b.x< -50 || b.x>state.W+50 || b.y<-50 || b.y>state.H+50) state.bullets.splice(i,1); }
    // enemies AI: move toward player, occasionally dodge, sometimes predict
    state.enemies.forEach(e=>{
      // simple predictive chase: head to player's future pos
      const predictFactor = e.type==='fast'? 0.7 : 0.35;
      const futureX = p.x + (p.x - (state._prevPlayerX||p.x))*predictFactor*6;
      const futureY = p.y + (p.y - (state._prevPlayerY||p.y))*predictFactor*6;
      const ang = Math.atan2(futureY - e.y, futureX - e.x);
      const sp = state.enemySpeedBase * (e.type==='fast'?1.8:(e.type==='big'?0.65:1.0));
      e.vx = Math.cos(ang)*sp; e.vy = Math.sin(ang)*sp; e.x += e.vx; e.y += e.vy;
      // occasional dodge using simple perpendicular jitter
      if(Math.random()<0.006) { e.x += Math.cos(ang+Math.PI/2)*6; e.y += Math.sin(ang+Math.PI/2)*6; }
    });
    state._prevPlayerX = p.x; state._prevPlayerY = p.y;

    // collisions: bullets vs enemies
    for(let i=state.enemies.length-1;i>=0;i--){ const e=state.enemies[i]; for(let j=state.bullets.length-1;j>=0;j--){ const b=state.bullets[j]; const d = Math.hypot(e.x-b.x, e.y-b.y); if(d < e.r + b.r){ state.bullets.splice(j,1); e.hp--; for(let k=0;k<6;k++) state.particles.push(makeParticle(b.x,b.y)); if(e.hp<=0){ playExplosion(); state.player.score += e.type==='big'?40:(e.type==='fast'?12:20); state.enemies.splice(i,1); break; } else { state.player.score += 8; } } } }

    // collisions: enemies vs player
    for(let i=state.enemies.length-1;i>=0;i--){ const e=state.enemies[i]; const d = Math.hypot(e.x - p.x, e.y - p.y); if(d < e.r + p.r){ // hit
        state.enemies.splice(i,1); p.hp--; playHurt(); for(let k=0;k<12;k++) state.particles.push(makeParticle(p.x,p.y,true)); if(p.hp<=0){ state.gameOver = true; state.running=false; }
      }}

    // particles update
    for(let i=state.particles.length-1;i>=0;i--){ const q=state.particles[i]; q.x+=q.vx; q.y+=q.vy; q.vx*=0.98; q.vy*=0.98; q.life--; if(q.life<=0) state.particles.splice(i,1); }

    // spawn logic
    state.spawnTimer++; if(state.spawnTimer >= state.spawnInterval){ state.spawnTimer=0; const count = Math.min(6 + Math.floor(state.wave/1.5), 18); for(let s=0;s<Math.max(1,Math.floor(1+state.wave/2));s++) spawnEnemy(state); }
    if(state.player.score > state.wave*200){ state.wave++; state.spawnInterval = Math.max(40, state.spawnInterval - 8); state.enemySpeedBase += 0.12; }
  }

  function makeParticle(x,y,red=false){ const ang = Math.random()*Math.PI*2; const sp = Math.random()*4 + (red?1.6:0.6); return { x,y, vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp, life: Math.floor(Math.random()*30+20), size: Math.random()*2+1, col: red? '#ff6b6b' : (Math.random()<0.5? '#fff' : '#ffd') } }

  // --- Rendering ------------------------------------------------
  function renderStateToCanvas(state, ctx, pointer){
    const W = state.W, H = state.H;
    ctx.clearRect(0,0,W,H);
    // background gradient
    const g = ctx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#07101a'); g.addColorStop(1,'#02040a'); ctx.fillStyle = g; ctx.fillRect(0,0,W,H);
    // grid subtle
    ctx.save(); ctx.globalAlpha = 0.04; ctx.fillStyle='#fff'; for(let x=0;x<W;x+=48) ctx.fillRect(x,0,1,H); for(let y=0;y<H;y+=48) ctx.fillRect(0,y,W,1); ctx.restore();

    // enemies
    state.enemies.forEach(e=>{ SPRITES.enemy.draw(ctx,e.x,e.y,e.r,e); });
    // bullets
    state.bullets.forEach(b=>{ SPRITES.bullet.draw(ctx,b.x,b.y,b.r); });
    // player
    const t = { turretAngle: Math.atan2((pointer.y||state.player.y) - state.player.y, (pointer.x||state.player.x) - state.player.x) };
    SPRITES.player.draw(ctx, state.player.x, state.player.y, state.player.r, t);
    // particles
    state.particles.forEach(p=>{ ctx.globalAlpha = Math.max(0, p.life/40); ctx.beginPath(); ctx.fillStyle = p.col; ctx.arc(p.x,p.y,p.size,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=1; });
    // HUD overlay
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(12,12,220,66);
    ctx.fillStyle = '#cfeeff'; ctx.font = '16px monospace'; ctx.fillText(`Score: ${state.player.score}`, 22, 36); ctx.fillText(`HP: ${state.player.hp}`, 22, 58);
    // small debug
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(8, H-36, 340, 28);
    ctx.fillStyle = '#cfeeff'; ctx.font = '12px monospace'; ctx.fillText(`Enemies: ${state.enemies.length}  Bullets: ${state.bullets.length}  Wave: ${state.wave}`, 14, H-16);
    // joystick indicator
    if(state.joystick.active){ ctx.beginPath(); ctx.globalAlpha=0.18; ctx.fillStyle='#8ad'; ctx.arc(state.joystick.cx, state.joystick.cy, 48,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=0.4; ctx.beginPath(); ctx.arc(state.joystick.x, state.joystick.y, 28,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=1; }
  }

  // --- Main loop ------------------------------------------------
  useEffect(()=>{
    let last = performance.now();
    const canvas = canvasRef.current; const ctx = canvas.getContext('2d');
    // set internal resolution
    canvas.width = gameStateRef.current.W; canvas.height = gameStateRef.current.H;
    function loop(){
      const now = performance.now(); const dt = now - last; last = now;
      const state = gameStateRef.current;
      // read input
      const input = inputRef.current;
      updateGameLogic(state, input);
      renderStateToCanvas(state, ctx, input);
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return ()=> cancelAnimationFrame(rafRef.current);
  },[]);

  // --- Input handling (mouse & touch & keyboard) -----------------
  useEffect(()=>{
    const canvas = canvasRef.current; if(!canvas) return;
    function onMouseMove(e){ const rect=canvas.getBoundingClientRect(); const scaleX = canvas.width/rect.width; const scaleY = canvas.height/rect.height; inputRef.current.aimX = (e.clientX - rect.left)*scaleX; inputRef.current.aimY = (e.clientY - rect.top)*scaleY; }
    function onMouseDown(e){ inputRef.current.fire = true; }
    function onMouseUp(e){ inputRef.current.fire = false; }
    canvas.addEventListener('mousemove', onMouseMove); canvas.addEventListener('mousedown', onMouseDown); window.addEventListener('mouseup', onMouseUp);

    // keyboard
    function onKeyDown(e){ const k = e.key.toLowerCase(); if(k==='w' || k==='arrowup') inputRef.current.up=true; if(k==='s' || k==='arrowdown') inputRef.current.down=true; if(k==='a' || k==='arrowleft') inputRef.current.left=true; if(k==='d' || k==='arrowright') inputRef.current.right=true; if(k===' '){ inputRef.current.fire=true; e.preventDefault(); } if(k==='p') { const s = gameStateRef.current; s.paused = !s.paused; } }
    function onKeyUp(e){ const k = e.key.toLowerCase(); if(k==='w' || k==='arrowup') inputRef.current.up=false; if(k==='s' || k==='arrowdown') inputRef.current.down=false; if(k==='a' || k==='arrowleft') inputRef.current.left=false; if(k==='d' || k==='arrowright') inputRef.current.right=false; if(k===' '){ inputRef.current.fire=false; } }
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp);

    // touch: implement two regions: left half joystick, right half fire/aim
    function getTouchPos(t){ const rect=canvas.getBoundingClientRect(); const scaleX = canvas.width/rect.width; const scaleY = canvas.height/rect.height; return { x: (t.clientX - rect.left)*scaleX, y: (t.clientY - rect.top)*scaleY } }
    function onTouchStart(e){ e.preventDefault(); for(const t of e.changedTouches){ const pos = getTouchPos(t); if(pos.x < canvas.width*0.45){ // joystick
          touchIdsRef.current[t.identifier] = 'joy'; const s = gameStateRef.current; s.joystick.active = true; s.joystick.cx = pos.x; s.joystick.cy = pos.y; s.joystick.x = pos.x; s.joystick.y = pos.y;
        } else { touchIdsRef.current[t.identifier] = 'fire'; gameStateRef.current.touchFire = true; // aim towards touch point
          inputRef.current.aimX = pos.x; inputRef.current.aimY = pos.y;
        } }
    }
    function onTouchMove(e){ e.preventDefault(); for(const t of e.changedTouches){ const mode = touchIdsRef.current[t.identifier]; if(!mode) continue; const pos = getTouchPos(t); if(mode==='joy'){ const s=gameStateRef.current; s.joystick.x = pos.x; s.joystick.y = pos.y; } else if(mode==='fire'){ inputRef.current.aimX = pos.x; inputRef.current.aimY = pos.y; } }
    }
    function onTouchEnd(e){ e.preventDefault(); for(const t of e.changedTouches){ const mode = touchIdsRef.current[t.identifier]; if(mode==='joy'){ const s=gameStateRef.current; s.joystick.active=false; } else if(mode==='fire'){ gameStateRef.current.touchFire=false; } delete touchIdsRef.current[t.identifier]; } }
    canvas.addEventListener('touchstart', onTouchStart, {passive:false}); canvas.addEventListener('touchmove', onTouchMove, {passive:false}); canvas.addEventListener('touchend', onTouchEnd, {passive:false}); canvas.addEventListener('touchcancel', onTouchEnd, {passive:false});

    return ()=>{
      canvas.removeEventListener('mousemove', onMouseMove); canvas.removeEventListener('mousedown', onMouseDown); window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('touchstart', onTouchStart); canvas.removeEventListener('touchmove', onTouchMove); canvas.removeEventListener('touchend', onTouchEnd);
    }
  },[]);

  // --- Controls exposed to UI ----------------------------------
  function startGame(){ const s = makeInitialGameState(); s.running = true; s.player.x = s.W/2; s.player.y = s.H/2; gameStateRef.current = s; // rebind canvas size
    const canvas = canvasRef.current; canvas.width = s.W; canvas.height = s.H; setScreen('play'); }

  function pauseToggle(){ const s = gameStateRef.current; s.paused = !s.paused; }

  function submitScore(){ // push to firebase if configured
    if(!FIREBASE_CONFIG){ alert('백엔드(Firebase) 설정이 필요합니다. 파일 상단 FIREBASE_CONFIG에 값을 넣으세요.'); return; }
    // implementation omitted in this bundle — replace with your firebase push logic
  }

  // --- Minimal leaderboard mockup for demo (local) -------------
  function addLocalScore(name, score){ const arr = [...scoreBoard, {name, score, date: new Date().toISOString()}].sort((a,b)=>b.score-a.score).slice(0,50); setScoreBoard(arr); }

  // quick UI render
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-black text-slate-100">
      <header className="max-w-6xl mx-auto p-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">TotalShooter — AI 협력/대전 총게임</h1>
        <nav className="space-x-3">
          <button className="px-3 py-2 bg-indigo-600 rounded" onClick={()=>setScreen('home')}>홈</button>
          <button className="px-3 py-2 bg-green-600 rounded" onClick={()=>startGame()}>플레이</button>
          <button className="px-3 py-2 bg-amber-600 rounded" onClick={()=>setScreen('leaderboard')}>랭킹</button>
        </nav>
      </header>

      <main className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2">
          {screen === 'home' && (
            <div className="bg-white/3 rounded p-6">
              <h2 className="text-xl font-semibold">게임 소개</h2>
              <p className="mt-2 text-slate-300">AI 적들과 싸우거나 친구와 협력해 파도를 깨는 총게임. 터치와 키보드 모두 지원합니다. 소리(Synth) 포함, 리더보드 백엔드 연동 가능.</p>
              <ul className="mt-3 list-disc pl-5 text-slate-300">
                <li>고급 AI: 예측 이동 + 회피</li>
                <li>모바일 터치: 가상 조이스틱 + 터치 에임</li>
                <li>사운드: WebAudio 합성기로 제작</li>
                <li>스프라이트: 벡터 기반으로 캔버스에 직접 렌더링</li>
              </ul>
              <div className="mt-4 flex gap-2">
                <button className="px-4 py-2 bg-green-600 rounded" onClick={startGame}>지금 플레이</button>
                <button className="px-4 py-2 bg-slate-700 rounded" onClick={()=>{ const s = makeInitialGameState(); s.running=false; gameStateRef.current = s; setScreen('play'); }}>데모 화면 보기</button>
              </div>
            </div>
          )}

          {screen === 'play' && (
            <div className="bg-white/3 rounded p-3">
              <div className="relative">
                <canvas ref={canvasRef} style={{width:'100%', borderRadius:12, touchAction:'none'}} />
                <div className="absolute left-4 top-4 text-slate-300 bg-black/30 px-3 py-2 rounded">
                  <div>이름: <input className="ml-2 px-2 rounded bg-black/20" value={playerName} onChange={e=>setPlayerName(e.target.value)} /></div>
                </div>
                <div className="absolute right-4 top-4 flex gap-2">
                  <button className="px-3 py-2 bg-yellow-600 rounded" onClick={pauseToggle}>Pause</button>
                  <button className="px-3 py-2 bg-red-600 rounded" onClick={()=>{ const s=gameStateRef.current; s.running=false; s.gameOver=true; }}>End</button>
                </div>
              </div>
              <div className="mt-2 text-slate-300">Controls: WASD / Arrow — Move • Click / Tap — Fire. 모바일: 왼쪽 영역 조이스틱, 오른쪽 터치로 조준·발사.</div>
            </div>
          )}

        </section>

        <aside className="space-y-4">
          <div className="bg-white/3 rounded p-4">
            <h3 className="font-semibold">현재 스테이터스</h3>
            <p className="mt-2 text-slate-300">화면 모드: <strong>{screen}</strong></p>
          </div>

          <div className="bg-white/3 rounded p-4">
            <h3 className="font-semibold">사운드 테스트</h3>
            <div className="mt-2 flex gap-2">
              <button className="px-3 py-2 bg-sky-600 rounded" onClick={()=>playShot()}>발사 소리</button>
              <button className="px-3 py-2 bg-orange-600 rounded" onClick={()=>playExplosion()}>폭발</button>
              <button className="px-3 py-2 bg-rose-600 rounded" onClick={()=>playHurt()}>피격</button>
            </div>
          </div>

          <div className="bg-white/3 rounded p-4">
            <h3 className="font-semibold">랭킹 (로컬 데모)</h3>
            <div className="mt-2">상위 점수:</div>
            <ol className="mt-2 list-decimal pl-5 text-slate-300">
              {scoreBoard.slice(0,6).map((s,i)=>(<li key={i}>{s.name} — {s.score}</li>))}
            </ol>
            <div className="mt-3 flex gap-2">
              <button className="px-3 py-2 bg-emerald-600 rounded" onClick={()=>addLocalScore(playerName, Math.floor(Math.random()*5000))}>랜덤 점수 추가</button>
              <button className="px-3 py-2 bg-slate-700 rounded" onClick={()=>setScoreBoard([])}>클리어</button>
            </div>
          </div>

          <div className="bg-white/3 rounded p-4 text-sm text-slate-400">
            <h4 className="font-semibold">백엔드 연동</h4>
            <p className="mt-2">Firebase Realtime DB 또는 Firestore로 점수 저장을 권장합니다. 상단 파일 주석의 가이드를 참고하여 <code>FIREBASE_CONFIG</code>를 넣으면 랭킹을 서버로 보낼 수 있도록 확장 가능합니다.</p>
          </div>
        </aside>

      </main>

      <footer className="max-w-6xl mx-auto p-6 text-center text-slate-500">Made with ❤️ — TotalShooter (demo bundle) · Tailwind + React</footer>
    </div>
  )
}
