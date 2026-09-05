const canvas = document.querySelector("#world");
const context = canvas.getContext("2d");
const chartCanvas = document.querySelector("#populationChart");
const chartContext = chartCanvas.getContext("2d");
const counts = {
  plant: document.querySelector("#plantCount"),
  herbivore: document.querySelector("#herbivoreCount"),
  predator: document.querySelector("#predatorCount"),
};
const ageDisplay = document.querySelector("#worldAge");
const pauseButton = document.querySelector("#pauseButton");
const resetButton = document.querySelector("#resetButton");
const speedInput = document.querySelector("#speedInput");
const speedOutput = document.querySelector("#speedOutput");
const emptyState = document.querySelector("#emptyState");
const settingsDialog = document.querySelector("#settingsDialog");
const rulesDialog = document.querySelector("#rulesDialog");

const COLORS = { plant: "#68f56b", herbivore: "#ffd84a", predator: "#4b8dff" };
const settings = {
  startingPlants: 500,
  startingHerbivores: 50,
  startingPredators: 5,
  maxPopulation: 2000,
  speedGainPerLevel: .12,
  sizeGainPerLevel: 1.2,
  plantSpawnInterval: .5,
  plantLevelInterval: 12,
  plantPerpetualLevel: 8,
  plantClusterChance: .82,
  plantSizeGainPerLevel: .75,
  herbivoreSpeed: 13,
  herbivoreVision: 90,
  predatorSpeed: 15,
  predatorSpeedGainPerLevel: .25,
  predatorVision: 320,
  predatorIdleSpeedFactor: .25,
  predatorSlowDuration: 4,
  predatorSlowFactor: .45,
  predatorMealsPerOffspring: 3,
  herbivoreOffspringCount: 3,
  herbivoreMatingLevel: 2,
  herbivoreMateCooldown: 9,
  herbivoreEatCooldown: 3,
  herbivoreSlowDuration: 2.5,
  herbivoreSlowFactor: .5,
  predatorReproductionCooldown: 13,
  herbivoreLevelGain: .28,
  predatorLevelGain: .55,
  largerPreyAllowance: 1,
  plantsBlockPredators: true,
};

let organisms = [];
let paused = false;
let speed = 1;
let worldAge = 0;
let plantSpawnTimer = 0;
let chartSampleTimer = 0;
let populationHistory = [];
let lastFrame = performance.now();

const random = (min, max) => min + Math.random() * (max - min);
const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const canPredatorEatHerbivore = (predator, herbivore) =>
  Math.round(predator.size) + settings.largerPreyAllowance >= Math.round(herbivore.size);

class Organism {
  constructor(type, x = random(0, canvas.width), y = random(0, canvas.height)) {
    this.type = type;
    this.x = x;
    this.y = y;
    this.level = 1;
    this.energy = type === "plant" ? Infinity : type === "herbivore" ? 75 : 100;
    this.age = 0;
    this.reproductionCooldown = random(0, 7);
    this.heading = random(0, Math.PI * 2);
    this.turnTimer = random(.4, 2.5);
    this.avoidanceTimer = 0;
    this.avoidanceHeading = 0;
    this.slowTimer = 0;
    this.eatCooldown = 0;
    this.herbivoreMeals = 0;
    this.isChasing = false;
    this.dead = false;
  }

  get size() { return this.type === "plant" ? 3 + Math.min(5, (this.level - 1) * settings.plantSizeGainPerLevel) : 3 + Math.min(8, (this.level - 1) * settings.sizeGainPerLevel); }
  get moveSpeed() {
    const base = this.type === "herbivore" ? settings.herbivoreSpeed : settings.predatorSpeed;
    const speedGain = this.type === "predator" ? settings.predatorSpeedGainPerLevel : settings.speedGainPerLevel;
    const levelMultiplier = 1 + Math.min(2.5, (this.level - 1) * speedGain);
    const mealMultiplier = this.slowTimer > 0
      ? (this.type === "predator" ? settings.predatorSlowFactor : settings.herbivoreSlowFactor)
      : 1;
    const idleMultiplier = this.type === "predator" && !this.isChasing ? settings.predatorIdleSpeedFactor : 1;
    return base * levelMultiplier * mealMultiplier * idleMultiplier;
  }

  update(dt) {
    this.age += dt;
    if (this.type === "plant") {
      this.level = Math.min(settings.plantPerpetualLevel, 1 + Math.floor(this.age / settings.plantLevelInterval));
      return;
    }
    this.reproductionCooldown -= dt;
    this.turnTimer -= dt;
    this.avoidanceTimer = Math.max(0, this.avoidanceTimer - dt);
    this.slowTimer = Math.max(0, this.slowTimer - dt);
    this.eatCooldown = Math.max(0, this.eatCooldown - dt);

    let target = null;
    let nearest = Infinity;
    const baseVision = this.type === "herbivore" ? settings.herbivoreVision : settings.predatorVision;
    const vision = (baseVision + this.level * 10) ** 2;
    let fleeing = false;

    if (this.type === "herbivore") {
      for (const other of organisms) {
        if (other.dead || other.type !== "predator") continue;
        const d = distanceSquared(this, other);
        if (d < vision && d < nearest) { nearest = d; target = other; fleeing = true; }
      }
      if (!target && this.level >= settings.herbivoreMatingLevel && this.reproductionCooldown <= 0 && this.energy > 45) {
        for (const other of organisms) {
          const eligibleMate = other !== this && !other.dead && other.type === "herbivore" &&
            other.level >= settings.herbivoreMatingLevel && other.reproductionCooldown <= 0 && other.energy > 45;
          if (!eligibleMate) continue;
          const d = distanceSquared(this, other);
          if (d < vision && d < nearest) { nearest = d; target = other; }
        }
      }
      if (!target && this.eatCooldown <= 0) {
        for (const other of organisms) {
          if (other.dead || other.type !== "plant" || other.level >= settings.plantPerpetualLevel) continue;
          const d = distanceSquared(this, other);
          if (d < vision && d < nearest) { nearest = d; target = other; }
        }
      }
    } else {
      for (const other of organisms) {
        const huntable = other.type === "herbivore" && canPredatorEatHerbivore(this, other);
        if (other === this || other.dead || !huntable) continue;
        const d = distanceSquared(this, other);
        if (d < vision && d < nearest) { nearest = d; target = other; }
      }
    }

    this.isChasing = this.type === "predator" && Boolean(target);
    const energyRate = this.type === "herbivore" ? 1.7 : (this.isChasing ? 2.1 : .65);
    this.energy -= dt * energyRate * (1 + this.level * .04);
    if (this.energy <= 0 || this.age > 150) { this.dead = true; return; }

    if (this.type === "predator" && this.avoidanceTimer > 0) {
      this.heading = this.avoidanceHeading;
    } else if (target) {
      const targetAngle = Math.atan2(target.y - this.y, target.x - this.x);
      this.heading = fleeing ? targetAngle + Math.PI : targetAngle;
    }
    else if (this.turnTimer <= 0) {
      this.heading += random(-1.4, 1.4);
      this.turnTimer = random(.5, 2.2);
    }

    const previousX = this.x;
    const previousY = this.y;
    this.x += Math.cos(this.heading) * this.moveSpeed * dt;
    this.y += Math.sin(this.heading) * this.moveSpeed * dt;
    if (this.x < 0 || this.x > canvas.width) { this.heading = Math.PI - this.heading; this.x = Math.max(0, Math.min(canvas.width, this.x)); }
    if (this.y < 0 || this.y > canvas.height) { this.heading = -this.heading; this.y = Math.max(0, Math.min(canvas.height, this.y)); }

    if (this.type === "predator" && settings.plantsBlockPredators) {
      const blockedByPlant = organisms.some((other) =>
        !other.dead &&
        other.type === "plant" &&
        distanceSquared(this, other) < (this.size / 2 + other.size / 2 + 1) ** 2
      );
      if (blockedByPlant) {
        this.x = previousX;
        this.y = previousY;
        this.avoidanceHeading = this.heading + (Math.random() < .5 ? -1 : 1) * random(Math.PI * .35, Math.PI * .65);
        this.heading = this.avoidanceHeading;
        this.avoidanceTimer = random(.7, 1.4);
        this.turnTimer = this.avoidanceTimer;
      }
    }

    this.interact();
  }

  interact() {
    const radius = this.size + 4;
    for (const other of organisms) {
      if (other === this || other.dead || distanceSquared(this, other) > radius ** 2) continue;
      const canEatPlant = this.type === "herbivore" && this.eatCooldown <= 0 &&
        other.type === "plant" && other.level < settings.plantPerpetualLevel;
      const canEatHerbivore = this.type === "predator" && other.type === "herbivore" && canPredatorEatHerbivore(this, other);
      if (canEatPlant || canEatHerbivore) {
        other.dead = true;
        if (this.type === "predator") {
          this.slowTimer = settings.predatorSlowDuration;
          if (canEatHerbivore) this.herbivoreMeals += 1;
        } else if (canEatPlant) {
          this.eatCooldown = settings.herbivoreEatCooldown;
          this.slowTimer = settings.herbivoreSlowDuration;
        }
        this.energy = Math.min(160, this.energy + (this.type === "predator" ? 48 : 27));
        this.level = Math.min(8, this.level + (this.type === "predator" ? settings.predatorLevelGain : settings.herbivoreLevelGain));
        if (this.type === "predator" && this.herbivoreMeals >= settings.predatorMealsPerOffspring &&
            this.reproductionCooldown <= 0 && organisms.length < settings.maxPopulation) {
          organisms.push(new Organism("predator"));
          this.herbivoreMeals = 0;
          this.reproductionCooldown = settings.predatorReproductionCooldown;
          this.energy *= .7;
        }
        return;
      }
      if (this.type === "herbivore" && other.type === "herbivore" &&
          this.level >= settings.herbivoreMatingLevel && other.level >= settings.herbivoreMatingLevel &&
          this.reproductionCooldown <= 0 && other.reproductionCooldown <= 0 &&
          this.energy > 45 && other.energy > 45 && organisms.length < settings.maxPopulation) {
        const centerX = (this.x + other.x) / 2;
        const centerY = (this.y + other.y) / 2;
        const availableSlots = settings.maxPopulation - organisms.length;
        const offspringCount = Math.min(settings.herbivoreOffspringCount, availableSlots);
        for (let i = 0; i < offspringCount; i++) {
          const offspring = new Organism("herbivore", centerX + random(-8, 8), centerY + random(-8, 8));
          offspring.reproductionCooldown = settings.herbivoreMateCooldown;
          organisms.push(offspring);
        }
        this.reproductionCooldown = other.reproductionCooldown = settings.herbivoreMateCooldown;
        this.energy -= 14;
        other.energy -= 14;
        return;
      }
    }
  }

  draw() {
    const size = Math.max(2, Math.round(this.size));
    context.fillStyle = COLORS[this.type];
    context.shadowColor = COLORS[this.type];
    context.shadowBlur = this.type === "plant" ? 3 : 7;
    context.fillRect(Math.round(this.x - size / 2), Math.round(this.y - size / 2), size, size);
    context.shadowBlur = 0;
    if (this.level >= 3) {
      context.fillStyle = "rgba(255,255,255,.72)";
      context.fillRect(Math.round(this.x), Math.round(this.y), 1, 1);
    }
    if (this.type === "plant" && this.level >= settings.plantPerpetualLevel) {
      context.strokeStyle = "rgba(255,255,255,.9)";
      context.lineWidth = 1;
      context.strokeRect(Math.round(this.x - size / 2) - 1, Math.round(this.y - size / 2) - 1, size + 2, size + 2);
    }
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const previousWidth = canvas.width || rect.width;
  const previousHeight = canvas.height || rect.height;
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));
  organisms.forEach((o) => {
    o.x = o.x / previousWidth * canvas.width;
    o.y = o.y / previousHeight * canvas.height;
  });
}

function resizeChart() {
  const rect = chartCanvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  chartCanvas.width = Math.max(1, Math.floor(rect.width * ratio));
  chartCanvas.height = Math.max(1, Math.floor(rect.height * ratio));
}

function getTotals() {
  const totals = { plant: 0, herbivore: 0, predator: 0 };
  organisms.forEach((organism) => { if (!organism.dead) totals[organism.type]++; });
  return totals;
}

function spawnPlant() {
  const plants = organisms.filter((organism) => !organism.dead && organism.type === "plant");
  if (plants.length && Math.random() < settings.plantClusterChance) {
    const weightTotal = plants.reduce((sum, plant) => sum + plant.level ** 2, 0);
    let choice = random(0, weightTotal);
    let parent = plants[0];
    for (const plant of plants) {
      choice -= plant.level ** 2;
      if (choice <= 0) { parent = plant; break; }
    }
    const spread = Math.max(10, 46 - parent.level * 4);
    const angle = random(0, Math.PI * 2);
    const radius = random(5, spread);
    organisms.push(new Organism("plant",
      Math.max(0, Math.min(canvas.width, parent.x + Math.cos(angle) * radius)),
      Math.max(0, Math.min(canvas.height, parent.y + Math.sin(angle) * radius))));
  } else {
    organisms.push(new Organism("plant"));
  }
}

function drawChart() {
  const width = chartCanvas.width;
  const height = chartCanvas.height;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const styles = getComputedStyle(document.documentElement);
  const muted = styles.getPropertyValue("--muted").trim();
  const line = styles.getPropertyValue("--line").trim();
  const firstTime = 0;
  const lastTime = populationHistory.at(-1)?.time || Math.max(1, worldAge);
  const duration = Math.max(1, lastTime - firstTime);
  const species = [
    { type: "plant", label: "Plants" },
    { type: "herbivore", label: "Herbivores" },
    { type: "predator", label: "Predators" },
  ];
  const chartGap = 9 * ratio;
  const bottomSpace = 18 * ratio;
  const facetHeight = (height - bottomSpace - chartGap * 2) / 3;
  const left = 36 * ratio;
  const right = 7 * ratio;
  const innerWidth = Math.max(1, width - left - right);

  chartContext.clearRect(0, 0, width, height);
  chartContext.font = `${9 * ratio}px ui-monospace, monospace`;
  chartContext.textBaseline = "middle";
  species.forEach(({ type, label }, speciesIndex) => {
    const top = speciesIndex * (facetHeight + chartGap);
    const plotTop = top + 14 * ratio;
    const plotHeight = Math.max(1, facetHeight - 15 * ratio);
    const highest = Math.max(1, ...populationHistory.map((point) => point[type]));
    const step = highest <= 10 ? 2 : highest <= 50 ? 10 : highest <= 200 ? 25 : highest <= 1000 ? 100 : 250;
    const ceiling = Math.max(step, Math.ceil(highest / step) * step);

    chartContext.textAlign = "left";
    chartContext.fillStyle = COLORS[type];
    chartContext.fillRect(left, top + 3 * ratio, 5 * ratio, 5 * ratio);
    chartContext.fillStyle = muted;
    chartContext.fillText(label, left + 9 * ratio, top + 6 * ratio);

    for (let i = 0; i <= 2; i++) {
      const y = plotTop + plotHeight * i / 2;
      chartContext.strokeStyle = line;
      chartContext.lineWidth = ratio;
      chartContext.beginPath();
      chartContext.moveTo(left, y);
      chartContext.lineTo(width - right, y);
      chartContext.stroke();
      chartContext.fillStyle = muted;
      chartContext.textAlign = "right";
      chartContext.fillText(Math.round(ceiling * (1 - i / 2)), left - 5 * ratio, y);
    }

    chartContext.strokeStyle = COLORS[type];
    chartContext.lineWidth = 1.5 * ratio;
    chartContext.lineJoin = "round";
    chartContext.beginPath();
    populationHistory.forEach((point, index) => {
      const x = left + (point.time - firstTime) / duration * innerWidth;
      const y = plotTop + (1 - point[type] / ceiling) * plotHeight;
      if (index === 0) chartContext.moveTo(x, y); else chartContext.lineTo(x, y);
    });
    chartContext.stroke();
  });

  chartContext.fillStyle = muted;
  chartContext.textAlign = "left";
  chartContext.fillText(`${Math.floor(firstTime)}s`, left, height - 6 * ratio);
  chartContext.textAlign = "right";
  chartContext.fillText(`${Math.floor(lastTime)}s`, width - right, height - 6 * ratio);
}

function addPlantPatch(x, y, amount = 12) {
  for (let i = 0; i < amount && organisms.length < settings.maxPopulation; i++) {
    organisms.push(new Organism("plant", Math.max(0, Math.min(canvas.width, x + random(-28, 28))), Math.max(0, Math.min(canvas.height, y + random(-28, 28)))));
  }
}

function resetWorld() {
  organisms = [];
  worldAge = 0;
  plantSpawnTimer = 0;
  chartSampleTimer = 0;
  populationHistory = [];
  const startingPopulation = {
    plant: settings.startingPlants,
    herbivore: settings.startingHerbivores,
    predator: settings.startingPredators,
  };
  for (const [type, amount] of Object.entries(startingPopulation)) {
    for (let i = 0; i < amount; i++) organisms.push(new Organism(type));
  }
  updateStats();
  populationHistory.push({ time: 0, ...getTotals() });
  drawChart();
}

function updateStats() {
  const totals = getTotals();
  Object.keys(totals).forEach((type) => { counts[type].textContent = totals[type]; });
  const minutes = Math.floor(worldAge / 60);
  const seconds = Math.floor(worldAge % 60).toString().padStart(2, "0");
  ageDisplay.textContent = `${minutes}:${seconds}`;
  emptyState.hidden = totals.herbivore + totals.predator > 0;
}

function frame(now) {
  const realDt = Math.min(.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!paused) {
    const dt = realDt * speed;
    worldAge += dt;
    plantSpawnTimer += dt;
    chartSampleTimer += dt;
    while (plantSpawnTimer > settings.plantSpawnInterval && organisms.length < settings.maxPopulation) {
      plantSpawnTimer -= settings.plantSpawnInterval;
      spawnPlant();
    }
    organisms.slice().forEach((organism) => organism.update(dt));
    organisms = organisms.filter((organism) => !organism.dead);
    if (chartSampleTimer >= 1) {
      chartSampleTimer %= 1;
      populationHistory.push({ time: worldAge, ...getTotals() });
    }
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  organisms.forEach((organism) => organism.draw());
  updateStats();
  drawChart();
  requestAnimationFrame(frame);
}

pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume" : "Pause";
});
resetButton.addEventListener("click", resetWorld);
speedInput.addEventListener("input", () => {
  speed = Number(speedInput.value);
  speedOutput.textContent = `${speed}×`;
});
document.querySelector("#settingsButton").addEventListener("click", () => settingsDialog.showModal());
document.querySelector("#rulesButton").addEventListener("click", () => rulesDialog.showModal());
document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => document.querySelector(`#${button.dataset.close}`).close());
});
document.querySelectorAll(".modal").forEach((dialog) => {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
});
document.querySelectorAll("[data-setting]").forEach((input) => {
  const key = input.dataset.setting;
  if (input.type === "checkbox") input.checked = settings[key];
  else input.value = input.dataset.percent !== undefined ? settings[key] * 100 : settings[key];
  input.addEventListener("change", () => {
    settings[key] = input.type === "checkbox"
      ? input.checked
      : Number(input.value) / (input.dataset.percent !== undefined ? 100 : 1);
  });
});
canvas.addEventListener("pointerdown", (event) => {
  const rect = canvas.getBoundingClientRect();
  addPlantPatch(event.clientX - rect.left, event.clientY - rect.top);
});
window.addEventListener("resize", () => { resizeCanvas(); resizeChart(); });

resizeCanvas();
resizeChart();
resetWorld();
requestAnimationFrame(frame);
