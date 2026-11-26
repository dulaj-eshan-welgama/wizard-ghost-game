import {
  HandLandmarker,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const video = document.getElementById("webcam");

// UI Elements
const scoreDisplay = document.getElementById("scoreDisplay");
const rightHudDisplay = document.getElementById("rightHudDisplay");
const controlSwitchBtn = document.getElementById("controlSwitchBtn");
const soundToggleBtn = document.getElementById("soundToggleBtn");
const menuBtn = document.getElementById("menuBtn");
const menuOverlay = document.getElementById("menuOverlay");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const finalScoreText = document.getElementById("finalScoreText");
const selectHandBtn = document.getElementById("selectHandBtn");
const selectMouseBtn = document.getElementById("selectMouseBtn");
const statusText = document.getElementById("statusText");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingMsg = document.getElementById("loadingMsg");
const barFill = document.getElementById("barFill");
const barWiz = document.getElementById("barWiz");
const playBtn = document.getElementById("playBtn");
const soundMenuBtn = document.getElementById("soundMenuBtn");
let selectedMode = "classic";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setProgress(p, msg) {
  barFill.style.width = p + "%";
  barWiz.style.left = p + "%";
  if (msg) loadingMsg.textContent = msg;
}
const comboDisplay = document.getElementById("comboDisplay");
const statsRow = document.getElementById("statsRow");
const bestText = document.getElementById("bestText");

// --- PROGRESSION (saved locally): best scores, day streak, rank ---
const RANKS = [[0, "Apprentice"], [50, "Spell Caster"], [150, "Ghost Hunter"], [400, "Battle Mage"], [900, "Archmage"], [2000, "Lightning Legend"]];
const MODE_NAMES = { classic: "Classic", arcade: "Time Attack", zen: "Zen" };
let save = { best: {}, streak: 0, lastDay: "", total: 0 };
try { Object.assign(save, JSON.parse(localStorage.getItem("wizardLightningSave") || "{}")); } catch (e) {}
function persist() { try { localStorage.setItem("wizardLightningSave", JSON.stringify(save)); } catch (e) {} }
(function updateStreak() {
  const day = (d) => d.toISOString().slice(0, 10);
  const today = day(new Date());
  if (save.lastDay === today) return;
  save.streak = save.lastDay === day(new Date(Date.now() - 864e5)) ? save.streak + 1 : 1;
  save.lastDay = today;
  persist();
})();
function rankInfo() {
  let i = 0;
  RANKS.forEach((r, idx) => { if (save.total >= r[0]) i = idx; });
  const next = RANKS[i + 1];
  return { name: RANKS[i][1], toNext: next ? next[0] - save.total : 0, nextName: next ? next[1] : "" };
}
function updateMenuStats() {
  const r = rankInfo();
  const bests = Object.keys(MODE_NAMES).map((m) => `${MODE_NAMES[m]} ${save.best[m] || 0}`).join(" · ");
  statsRow.innerHTML = `<span>🔥 ${save.streak}-day streak</span><span>🎖️ ${r.name}${r.toNext ? ` (${r.toNext} ghosts to ${r.nextName})` : ""}</span><span>🏆 ${bests}</span>`;
}
updateMenuStats();
let flash = 0, gameStartTime = 0, nextLifeAt = 1500;
let comboHideAt = 0;

// Resize canvas
function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

// --- GAME STATE ---
let controlMode = "hand"; // "hand" | "mouse"
let gameMode = "classic"; // "classic" | "arcade" | "zen"
let soundEnabled = true;
let isPlaying = false;
let score = 0;
let lives = 3;
let timeLeft = 60;
let lastTimerTick = 0;
let screenShake = 0;

// Entities & Trails
let ghosts = [];
let particles = [];
let floatingTexts = [];
let trail = [];
let pointer = { x: canvas.width * 0.5, y: canvas.height * 0.5, vx: 0, vy: 0, active: false };
let targetPointer = { x: canvas.width * 0.5, y: canvas.height * 0.5 };
let comboCount = 0;
let lastZapTime = 0;
let spawnTimer = 0;

// --- AUDIO MANAGER (Uses assets/boom.mp3 + WebAudio Synth Fallback) ---
const bgMusic = new Audio("./bg-sound.mp3");
bgMusic.loop = true;
bgMusic.volume = 0.4;
function syncMusic() {
  if (soundEnabled && isPlaying) bgMusic.play().catch(() => {});
  else bgMusic.pause();
}

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const boomAudio = new Audio("./boom.mp3");
let customBoomReady = false;
boomAudio.addEventListener("canplaythrough", () => { customBoomReady = true; });

function playBoomSound(isBomb = false, combo = 0) {
  if (!soundEnabled) return;
  if (audioCtx.state === "suspended") audioCtx.resume();

  if (!isBomb && customBoomReady) {
    const clone = boomAudio.cloneNode();
    clone.volume = 0.85;
    clone.playbackRate = Math.min(1 + combo * 0.06, 1.7); // rising pitch rewards chains
    clone.play().catch(() => {});
    return;
  }

  // Synthesized Electric Boom / Explosion fallback
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = isBomb ? "sawtooth" : "triangle";
  osc.frequency.setValueAtTime(isBomb ? 140 : 520, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(isBomb ? 35 : 75, audioCtx.currentTime + 0.25);

  gain.gain.setValueAtTime(0.35, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.25);
}

// --- ASSET LOADER WITH AUTOMATIC WHITE-BACKGROUND REMOVAL ---
function loadAndKeyImage(src, removeWhite = false) {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = src;
    img.onload = () => {
      if (!removeWhite) return resolve(img);
      const off = document.createElement("canvas");
      off.width = img.width;
      off.height = img.height;
      const octx = off.getContext("2d");
      octx.drawImage(img, 0, 0);
      const imgData = octx.getImageData(0, 0, off.width, off.height);
      const d = imgData.data;
      if (d[3] < 250) return resolve(img); // already transparent PNG
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) {
          d[i + 3] = 0; // Make near-white pixels transparent
        }
      }
      octx.putImageData(imgData, 0, 0);
      resolve(off);
    };
    img.onerror = () => resolve(null);
  });
}

let bgImg = null, wizardImg = null, ghostImg = null;
Promise.all([
  loadAndKeyImage("./bg.jpeg", false),
  loadAndKeyImage("./wizard.png", true),
  loadAndKeyImage("./ghost.png", true)
]).then(([bg, wiz, gst]) => {
  bgImg = bg;
  wizardImg = wiz;
  ghostImg = gst;
});

// --- MEDIAPIPE HAND TRACKING ---
let handLandmarker = null;
let cameraRunning = false;

async function initHandTracking() {
  if (!handLandmarker) {
    setProgress(25, "SUMMONING HAND TRACKING...");
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numHands: 1
    });
  }

  if (!cameraRunning) {
    setProgress(60, "CONNECTING TO CAMERA...");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 }
    });
    video.srcObject = stream;
    await video.play();
    cameraRunning = true;
  }
  setProgress(90);
  video.style.display = "block";
  statusText.textContent = "";
}

function stopCameraView() {
  video.style.display = "none";
}

// --- MOUSE / TOUCH CONTROLS ---
window.addEventListener("mousemove", (e) => {
  if (controlMode !== "mouse") return;
  targetPointer.x = e.clientX;
  targetPointer.y = e.clientY;
  pointer.active = true;
});

window.addEventListener("touchmove", (e) => {
  if (controlMode !== "mouse" || !e.touches[0]) return;
  targetPointer.x = e.touches[0].clientX;
  targetPointer.y = e.touches[0].clientY;
  pointer.active = true;
}, { passive: true });

// --- UI EVENT LISTENERS ---
function setControlMode(mode) {
  controlMode = mode;
  selectHandBtn.classList.toggle("active", mode === "hand");
  selectMouseBtn.classList.toggle("active", mode === "mouse");
  controlSwitchBtn.textContent = mode === "hand" ? "Control: Hand Gesture" : "Control: Mouse";

  if (mode === "mouse") {
    stopCameraView();
    statusText.textContent = "";
  } else if (isPlaying) {
    initHandTracking().catch(() => {
      statusText.textContent = "Camera unavailable — switched to Mouse mode.";
      setControlMode("mouse");
    });
  }
}

selectHandBtn.onclick = () => setControlMode("hand");
selectMouseBtn.onclick = () => setControlMode("mouse");
controlSwitchBtn.onclick = () => setControlMode(controlMode === "hand" ? "mouse" : "hand");

soundToggleBtn.onclick = () => {
  soundEnabled = !soundEnabled;
  soundToggleBtn.textContent = soundMenuBtn.textContent = soundEnabled ? "Sound: ON" : "Sound: OFF";
  syncMusic();
};

menuBtn.onclick = () => {
  isPlaying = false;
  menuOverlay.classList.remove("hidden");
  gameOverOverlay.classList.add("hidden");
  syncMusic();
};

soundMenuBtn.onclick = () => soundToggleBtn.onclick();

document.querySelectorAll(".mode-card").forEach((card) => {
  card.onclick = () => {
    selectedMode = card.dataset.mode;
    document.querySelectorAll(".mode-card").forEach((c) => c.classList.toggle("selected", c === card));
  };
});
playBtn.onclick = () => startGame(selectedMode);

document.getElementById("restartBtn").onclick = () => startGame(gameMode);

// --- START & GAME FLOW ---
async function startGame(selectedMode) {
  gameMode = selectedMode;
  menuOverlay.classList.add("hidden");
  gameOverOverlay.classList.add("hidden");
  loadingOverlay.classList.remove("hidden");
  setProgress(8, controlMode === "hand" ? "CONNECTING TO CAMERA..." : "PREPARING THE ARENA...");
  const minWait = sleep(1400);
  if (controlMode === "hand") {
    try {
      await initHandTracking();
    } catch (err) {
      statusText.textContent = "Camera blocked or missing! Falling back to Mouse control.";
      setControlMode("mouse");
    }
  } else {
    setProgress(70);
    stopCameraView();
  }
  await minWait;
  setProgress(100, "READY!");
  await sleep(350);
  loadingOverlay.classList.add("hidden");

  score = 0;
  lives = 3;
  timeLeft = gameMode === "arcade" ? 60 : 90;
  lastTimerTick = performance.now();
  gameStartTime = lastTimerTick;
  nextLifeAt = 1500;
  flash = 0;
  ghosts = [];
  particles = [];
  floatingTexts = [];
  trail = [];
  comboCount = 0;
  isPlaying = true;
  comboDisplay.textContent = "";
  syncMusic();

  menuOverlay.classList.add("hidden");
  gameOverOverlay.classList.add("hidden");
  updateHud();
}

function updateHud() {
  scoreDisplay.textContent = score;
  if (gameMode === "classic") {
    const hearts = "❤️".repeat(Math.max(0, lives));
    const crosses = "❌".repeat(Math.max(0, 3 - lives));
    rightHudDisplay.textContent = crosses + hearts;
  } else {
    rightHudDisplay.textContent = `⏱️ ${Math.ceil(timeLeft)}s`;
  }
}

function triggerGameOver() {
  if (!isPlaying) return;
  isPlaying = false;
  finalScoreText.textContent = `Mode: ${gameMode.toUpperCase()} | Final Score: ${score}`;
  const prev = save.best[gameMode] || 0;
  if (score > prev) {
    save.best[gameMode] = score;
    bestText.textContent = prev ? `🏆 NEW BEST! (+${score - prev})` : "🏆 NEW BEST!";
  } else {
    bestText.textContent = `Only ${prev - score + 1} points from your best of ${prev} — one more try!`;
  }
  persist();
  updateMenuStats();
  const r = rankInfo();
  bestText.textContent += r.toNext ? `\n${r.toNext} ghosts until rank ${r.nextName}` : `\nRank: ${r.name}`;
  gameOverOverlay.classList.remove("hidden");
  syncMusic();
}

// --- SPAWNING GHOSTS & CURSED ORBS ---
function spawnEntity() {
  const isBomb = gameMode === "classic" && Math.random() < 0.18;
  const golden = !isBomb && Math.random() < 0.07; // rare bonus ghost
  const fromLeft = Math.random() < 0.65;
  const x = fromLeft ? -60 : Math.random() * (canvas.width * 0.55) + 60;
  const y = fromLeft ? Math.random() * (canvas.height * 0.6) + 100 : canvas.height + 60;

  const targetX = canvas.width * (0.25 + Math.random() * 0.45);
  const targetY = canvas.height * (0.18 + Math.random() * 0.45);
  const speed = gameMode === "arcade" ? 0.022 : 0.016;

  ghosts.push({
    x,
    y,
    vx: (targetX - x) * speed,
    vy: fromLeft ? (Math.random() - 0.5) * 4 : -(11 + Math.random() * 4),
    gravity: fromLeft ? 0.03 : 0.22,
    radius: isBomb ? 42 : 68,
    isBomb,
    golden,
    zapped: false,
    wobble: Math.random() * Math.PI * 2
  });
}

function createLightningExplosion(x, y, color = "#38bdf8") {
  for (let i = 0; i < 22; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spd = 2 + Math.random() * 8;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd,
      life: 1,
      color
    });
  }
}

const MILESTONES = { 3: "NICE!", 5: "GREAT!", 8: "AMAZING!", 12: "LEGENDARY!" };
function onGhostZapped(g, points) {
  save.total++;
  if (save.total % 10 === 0) persist();
  flash = Math.min(0.12 + comboCount * 0.03, 0.4);
  screenShake = 10 + Math.min(comboCount * 2, 18);
  if (g.golden) {
    createLightningExplosion(g.x, g.y, "#facc15");
    createLightningExplosion(g.x, g.y, "#ffffff");
    let bonus = "";
    if (gameMode === "classic" && lives < 3) { lives++; bonus = " +❤️"; }
    else if (gameMode !== "classic") { timeLeft += 3; bonus = " +3s"; }
    floatingTexts.push({ x: g.x, y: g.y - 50, text: `GOLDEN GHOST! +${points}${bonus}`, life: 1.4, size: 34, color: "#fde047" });
  }
  if (MILESTONES[comboCount]) {
    floatingTexts.push({ x: canvas.width * 0.5, y: canvas.height * 0.3, text: MILESTONES[comboCount], life: 1.4, size: 56, color: "#67e8f9" });
  }
  if (gameMode === "classic" && score >= nextLifeAt) {
    nextLifeAt += 1500;
    if (lives < 3) {
      lives++;
      floatingTexts.push({ x: canvas.width * 0.5, y: canvas.height * 0.45, text: "❤️ LIFE RESTORED", life: 1.4, size: 38, color: "#f87171" });
    }
  }
}

// --- MAIN LOOP ---
let lastVideoTime = -1;

function loop(now) {
  requestAnimationFrame(loop);

  // 1. Hand Tracking Update
  if (isPlaying && controlMode === "hand" && handLandmarker && video.readyState >= 2) {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const results = handLandmarker.detectForVideo(video, now);
      if (results.landmarks && results.landmarks.length > 0) {
        const indexTip = results.landmarks[0][8]; // Landmark #8 = Index Fingertip
        targetPointer.x = (1 - indexTip.x) * canvas.width; // Mirror horizontally
        targetPointer.y = indexTip.y * canvas.height;
        pointer.active = true;
      }
    }
  }

  // Smooth cursor interpolation (Lerp)
  const prevX = pointer.x;
  const prevY = pointer.y;
  pointer.x += (targetPointer.x - pointer.x) * 0.35;
  pointer.y += (targetPointer.y - pointer.y) * 0.35;
  pointer.vx = pointer.x - prevX;
  pointer.vy = pointer.y - prevY;
  const speed = Math.hypot(pointer.vx, pointer.vy);

  if (pointer.active) {
    trail.push({ x: pointer.x, y: pointer.y, speed, alpha: 1 });
    if (trail.length > 18) trail.shift();
  }

  if (comboHideAt && now > comboHideAt) { comboDisplay.textContent = ""; comboHideAt = 0; }

  // 2. Render Background & Wizard
  ctx.save();
  if (screenShake > 0) {
    ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
    screenShake *= 0.85;
  }

  if (bgImg) {
    const sc = Math.max(canvas.width / bgImg.width, canvas.height / bgImg.height);
    const bw = bgImg.width * sc, bh = bgImg.height * sc;
    ctx.drawImage(bgImg, (canvas.width - bw) / 2, (canvas.height - bh) / 2, bw, bh);
  } else {
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Wizard on broom (right side, bobbing, follows pointer height)
  let wand = null;
  if (wizardImg) {
    const wizH = Math.min(canvas.height * 0.6, 460);
    const wizW = (wizardImg.width / wizardImg.height) * wizH;
    const wizX = canvas.width - wizW - 10;
    const wizY = canvas.height * 0.22 + (pointer.y - canvas.height * 0.5) * 0.15 + Math.sin(now / 400) * 8;
    ctx.save();
    ctx.shadowColor = "rgba(120, 220, 120, 0.6)";
    ctx.shadowBlur = 12;
    ctx.drawImage(wizardImg, wizX, wizY, wizW, wizH);
    ctx.restore();
    wand = { x: wizX + wizW * 0.115, y: wizY + wizH * 0.29 }; // wand tip in wizard.png
  }

  // Lightning bolt from wand tip to pointer
  if (wand && pointer.active && isPlaying) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const dx = pointer.x - wand.x, dy = pointer.y - wand.y;
    const len = Math.hypot(dx, dy), segs = Math.max(6, Math.floor(len / 28));
    const nx = -dy / len, ny = dx / len;
    const pts = [{ x: wand.x, y: wand.y }];
    for (let i = 1; i < segs; i++) {
      const t = i / segs, j = (Math.random() - 0.5) * 36;
      pts.push({ x: wand.x + dx * t + nx * j, y: wand.y + dy * t + ny * j });
    }
    pts.push({ x: pointer.x, y: pointer.y });
    for (const [w, col, blur] of [[9, "rgba(56,189,248,0.55)", 25], [3, "#ffffff", 10]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.shadowColor = "#38bdf8"; ctx.shadowBlur = blur;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.shadowBlur = 30;
    ctx.beginPath(); ctx.arc(wand.x, wand.y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // 3. Game Logic Update
  if (isPlaying) {
    if (gameMode !== "classic") {
      timeLeft -= (now - lastTimerTick) / 1000;
      lastTimerTick = now;
      if (timeLeft <= 0) {
        timeLeft = 0;
        updateHud();
        triggerGameOver();
      }
      updateHud();
    }

    spawnTimer--;
    if (spawnTimer <= 0) {
      spawnEntity();
      const ramp = Math.max(0.55, 1 - (now - gameStartTime) / 120000); // difficulty slowly climbs
      spawnTimer = (gameMode === "arcade" ? 32 : 52) * ramp;
    }

    // Update & Draw Ghosts
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i];
      g.x += g.vx;
      g.y += g.vy;
      g.vy += g.gravity;
      g.wobble += 0.08;

      // Collision with lightning swipe
      const dist = Math.hypot(pointer.x - g.x, pointer.y - g.y);
      if (!g.zapped && speed > 4 && dist < g.radius + 25) {
        g.zapped = true;
        screenShake = 14;

        if (g.isBomb) {
          playBoomSound(true);
          createLightningExplosion(g.x, g.y, "#ef4444");
          comboCount = 0;
          comboDisplay.textContent = "";
          flash = 0.5;
          lives--;
          updateHud();
          if (lives <= 0) triggerGameOver();
        } else {
          playBoomSound(false, comboCount);
          createLightningExplosion(g.x, g.y, "#38bdf8");

          if (now - lastZapTime < 900) {
            comboCount++;
          } else {
            comboCount = 1;
          }
          lastZapTime = now;

          const points = g.golden ? 500 : comboCount >= 2 ? 100 * Math.min(comboCount, 10) : 100;
          score += points;
          onGhostZapped(g, points);
          updateHud();

          if (comboCount >= 2) {
            comboDisplay.textContent = `${comboCount} GHOST\nCOMBO`;
            comboHideAt = now + 1500;
            floatingTexts.push({
              x: g.x,
              y: g.y - 20,
              text: `${comboCount} GHOST COMBO +${points}`,
              life: 1
            });
          }
        }
        ghosts.splice(i, 1);
        continue;
      }

      // Remove if off-screen
      if (g.x > canvas.width + 120 || g.y > canvas.height + 140) {
        if (!g.isBomb && !g.golden && gameMode === "classic") {
          lives--;
          updateHud();
          if (lives <= 0) triggerGameOver();
        }
        ghosts.splice(i, 1);
        continue;
      }

      // Draw Entity
      ctx.save();
      ctx.translate(g.x, g.y + Math.sin(g.wobble) * 6);
      if (g.isBomb) {
        ctx.shadowColor = "#ef4444";
        ctx.shadowBlur = 25;
        ctx.fillStyle = "#1e1b4b";
        ctx.beginPath();
        ctx.arc(0, 0, g.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#f87171";
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.font = "36px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("💀", 0, 2);
      } else if (ghostImg) {
        ctx.shadowColor = g.golden ? "#facc15" : "#38bdf8";
        ctx.shadowBlur = g.golden ? 40 : 22;
        if (g.golden) ctx.filter = "sepia(1) saturate(6) hue-rotate(-12deg) brightness(1.25)";
        const gh = g.radius * 2.3;
        const gw = (ghostImg.width / ghostImg.height) * gh;
        ctx.drawImage(ghostImg, -gw / 2, -gh / 2, gw, gh);
      }
      ctx.restore();
    }
  }

  // 4. Draw Particles & Floating Combo Text
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 0.04;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (let i = floatingTexts.length - 1; i >= 0; i--) {
    const ft = floatingTexts[i];
    ft.y -= 1.2;
    ft.life -= 0.025;
    if (ft.life <= 0) {
      floatingTexts.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = ft.life;
    ctx.font = `900 ${ft.size || 26}px sans-serif`;
    ctx.fillStyle = ft.color || "#facc15";
    ctx.textAlign = "center";
    ctx.fillText(ft.text, ft.x, ft.y);
  }
  ctx.globalAlpha = 1;

  // 5. Draw Jagged Lightning Wand Trail
  if (trail.length > 1) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = "#38bdf8";
    ctx.shadowColor = "#7dd3fc";
    ctx.shadowBlur = 20;
    ctx.lineCap = "round";

    for (let i = 1; i < trail.length; i++) {
      const p1 = trail[i - 1];
      const p2 = trail[i];
      p1.alpha *= 0.9;
      const jitterX = (Math.random() - 0.5) * 14;
      const jitterY = (Math.random() - 0.5) * 14;

      ctx.lineWidth = (i / trail.length) * 10;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo((p1.x + p2.x) / 2 + jitterX, (p1.y + p2.y) / 2 + jitterY);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Wand Tip Spark
  if (pointer.active) {
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "#38bdf8";
    ctx.shadowBlur = 25;
    ctx.beginPath();
    ctx.arc(pointer.x, pointer.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (flash > 0.01) {
    ctx.fillStyle = `rgba(180, 235, 255, ${flash})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    flash *= 0.85;
  }

  ctx.restore();
}

window.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && !gameOverOverlay.classList.contains("hidden")) startGame(gameMode);
});

requestAnimationFrame(loop);