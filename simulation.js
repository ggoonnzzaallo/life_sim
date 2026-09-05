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
  maxPopulation: 5000,
  maxSpeciesShare: .9,
  mapScale: 1.5,
  oldAgeEnabled: false,
  animalLifespan: 150,
  speedGainPerLevel: .12,
  sizeGainPerLevel: 1.2,
  plantSpawnInterval: .2,
  plantLevelInterval: 60,
  plantLevelJitter: .35,
  plantPerpetualLevel: 8,
  perpetualPlantRadius: 70,
  plantClusterChance: .82,
  plantMaxSeedlings: 4,
  plantSizeGainPerLevel: .75,
  herbivoreSpeed: 13,
  herbivoreMaxLevel: 5,
  herbivoreVision: 90,
  herdAwarenessRadius: 80,
  herdVigilancePerMember: .15,
  herdVigilanceMaxBonus: 1.5,
  predatorSpeed: 17,
  predatorMaxLevel: 3,
  predatorSpeedGainPerLevel: .18,
  predatorVision: 210,
  predatorIdleSpeedFactor: .25,
  predatorSlowDuration: 4,
  predatorSlowFactor: .45,
  predatorEatCooldown: 3.5,
  predatorChaseEnergyDrain: 1.25,
  predatorIdleEnergyDrain: .35,
  predatorMealEnergy: 60,
  predatorMealsPerOffspring: 2,
  herbivoreMinOffspring: 2,
  herbivoreMaxOffspring: 4,
  herbivoreMatingLevel: 2,
  herbivoreMateCooldown: 9,
  herbivoreEatCooldown: 3,
  herbivoreSlowDuration: 2.5,
  herbivoreSlowFactor: .5,
  herbivoreMigrationInterval: 55,
  herbivoreMigrationCount: 4,
  predatorMigrationInterval: 180,
  predatorMigrationCount: 1,
  herbivoreLevelGain: .28,
  predatorLevel2Meals: 3,
  predatorLevel3Meals: 8,
  largerPreyAllowance: 1,
  cannibalLevelGap: 1,
  plantsBlockPredators: true,
};

try {
  const savedSettings = JSON.parse(localStorage.getItem("pixelLifeSettings") || "null");
  if (savedSettings && typeof savedSettings === "object") Object.assign(settings, savedSettings);
} catch {
  // Ignore malformed or unavailable browser storage and use built-in defaults.
}

let organisms = [];
let paused = false;
let speed = 1;
let worldAge = 0;
let plantSpawnTimer = 0;
let chartSampleTimer = 0;
let populationHistory = [];
let migrationTimers = { herbivore: 0, predator: 0 };
let spatialIndex = new Map();
let chartDirty = true;
let lastFrame = performance.now();

const random = (min, max) => min + Math.random() * (max - min);
const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const GRID_SIZE = 64;
const gridKey = (column, row) => `${column},${row}`;

function buildSpatialIndex() {
  spatialIndex = new Map();
  organisms.forEach((organism) => {
    if (organism.dead) return;
    const key = gridKey(Math.floor(organism.x / GRID_SIZE), Math.floor(organism.y / GRID_SIZE));
    if (!spatialIndex.has(key)) spatialIndex.set(key, []);
    spatialIndex.get(key).push(organism);
  });
}

function nearbyOrganisms(x, y, radius) {
  const nearby = [];
  const minColumn = Math.floor((x - radius) / GRID_SIZE);
  const maxColumn = Math.floor((x + radius) / GRID_SIZE);
  const minRow = Math.floor((y - radius) / GRID_SIZE);
  const maxRow = Math.floor((y + radius) / GRID_SIZE);
  for (let column = minColumn; column <= maxColumn; column++) {
    for (let row = minRow; row <= maxRow; row++) {
      const cell = spatialIndex.get(gridKey(column, row));
      if (cell) nearby.push(...cell);
    }
  }
  return nearby;
}
const trackAnalytics = (event, properties = {}) => {
  if (window.posthog?.capture) window.posthog.capture(event, properties);
};
const canPredatorEatHerbivore = (predator, herbivore) =>
  predator.level >= settings.predatorMaxLevel ||
  Math.round(predator.size) + settings.largerPreyAllowance >= Math.round(herbivore.size);
const canHerbivoreEatPlant = (herbivore, plant) =>
  (plant.level < settings.plantPerpetualLevel && plant.level <= herbivore.level) ||
  (plant.level >= settings.plantPerpetualLevel && herbivore.level >= settings.herbivoreMaxLevel);

function availableSpeciesSlots(type) {
  const totalSlots = Math.max(0, settings.maxPopulation - organisms.length);
  const speciesLimit = Math.max(1, Math.floor(settings.maxPopulation * settings.maxSpeciesShare));
  const speciesPopulation = organisms.reduce((count, organism) =>
    count + (!organism.dead && organism.type === type ? 1 : 0), 0);
  return Math.max(0, Math.min(totalSlots, speciesLimit - speciesPopulation));
}

const canAddSpecies = (type) => availableSpeciesSlots(type) > 0;

class Organism {
  constructor(type, x = random(0, canvas.width), y = random(0, canvas.height)) {
    this.type = type;
    this.x = x;
    this.y = y;
    this.level = 1;
    this.energy = type === "plant" ? Infinity : type === "herbivore" ? 75 : 100;
    this.age = 0;
    this.levelTimingRoll = type === "plant" ? random(-1, 1) : 0;
    this.reproductionCooldown = random(0, 7);
    this.heading = random(0, Math.PI * 2);
    this.turnTimer = random(.4, 2.5);
    this.avoidanceTimer = 0;
    this.avoidanceHeading = 0;
    this.slowTimer = 0;
    this.eatCooldown = 0;
    this.herbivoreMeals = 0;
    this.predatorExperience = 0;
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
      const individualLevelInterval = settings.plantLevelInterval *
        Math.max(.2, 1 + this.levelTimingRoll * settings.plantLevelJitter);
      const proposedLevel = Math.min(settings.plantPerpetualLevel, 1 + Math.floor(this.age / individualLevelInterval));
      if (proposedLevel >= settings.plantPerpetualLevel && this.level < settings.plantPerpetualLevel) {
        const radiusSquared = settings.perpetualPlantRadius ** 2;
        const nearbyPerpetualPlant = nearbyOrganisms(this.x, this.y, settings.perpetualPlantRadius).some((other) =>
          other !== this && !other.dead && other.type === "plant" &&
          other.level >= settings.plantPerpetualLevel && distanceSquared(this, other) <= radiusSquared
        );
        this.level = nearbyPerpetualPlant ? settings.plantPerpetualLevel - 1 : proposedLevel;
      } else {
        this.level = proposedLevel;
      }
      return;
    }
    this.reproductionCooldown -= dt;
    this.turnTimer -= dt;
    this.avoidanceTimer = Math.max(0, this.avoidanceTimer - dt);
    this.slowTimer = Math.max(0, this.slowTimer - dt);
    this.eatCooldown = Math.max(0, this.eatCooldown - dt);

    let target = null;
    let nearest = Infinity;
    const baseVision = (this.type === "herbivore" ? settings.herbivoreVision : settings.predatorVision) + this.level * 10;
    const vision = baseVision ** 2;
    let fleeing = false;

    if (this.type === "herbivore") {
      const herdRadiusSquared = settings.herdAwarenessRadius ** 2;
      const nearbyHerdMembers = nearbyOrganisms(this.x, this.y, settings.herdAwarenessRadius).reduce((count, other) =>
        count + (other !== this && !other.dead && other.type === "herbivore" &&
          distanceSquared(this, other) <= herdRadiusSquared ? 1 : 0), 0);
      const herdBonus = Math.min(settings.herdVigilanceMaxBonus, nearbyHerdMembers * settings.herdVigilancePerMember);
      const threatVision = (baseVision * (1 + herdBonus)) ** 2;
      for (const other of nearbyOrganisms(this.x, this.y, Math.sqrt(threatVision))) {
        if (other.dead || other.type !== "predator") continue;
        const d = distanceSquared(this, other);
        if (d < threatVision && d < nearest) { nearest = d; target = other; fleeing = true; }
      }
      if (!target && this.level >= settings.herbivoreMatingLevel && this.reproductionCooldown <= 0 && this.energy > 45) {
        for (const other of nearbyOrganisms(this.x, this.y, baseVision)) {
          const eligibleMate = other !== this && !other.dead && other.type === "herbivore" &&
            other.level >= settings.herbivoreMatingLevel && other.reproductionCooldown <= 0 && other.energy > 45;
          if (!eligibleMate) continue;
          const d = distanceSquared(this, other);
          if (d < vision && d < nearest) { nearest = d; target = other; }
        }
      }
      if (!target && this.eatCooldown <= 0) {
        for (const other of nearbyOrganisms(this.x, this.y, baseVision)) {
          if (other.dead || other.type !== "plant" || !canHerbivoreEatPlant(this, other)) continue;
          const d = distanceSquared(this, other);
          if (d < vision && d < nearest) { nearest = d; target = other; }
        }
      }
    } else if (this.eatCooldown <= 0) {
      const predatorPopulation = organisms.reduce((count, organism) =>
        count + (!organism.dead && organism.type === "predator" ? 1 : 0), 0);
      for (const other of nearbyOrganisms(this.x, this.y, baseVision)) {
        const huntable = (other.type === "herbivore" && canPredatorEatHerbivore(this, other)) ||
          (predatorPopulation > 3 && other.type === "predator" && other.level >= 2 &&
            this.level >= other.level + settings.cannibalLevelGap);
        if (other === this || other.dead || !huntable) continue;
        const d = distanceSquared(this, other);
        if (d < vision && d < nearest) { nearest = d; target = other; }
      }
    }

    this.isChasing = this.type === "predator" && Boolean(target);
    const energyRate = this.type === "herbivore"
      ? 1.7
      : (this.isChasing ? settings.predatorChaseEnergyDrain : settings.predatorIdleEnergyDrain);
    this.energy -= dt * energyRate * (1 + this.level * .04);
    if (this.energy <= 0 || (settings.oldAgeEnabled && this.age > settings.animalLifespan)) {
      this.dead = true;
      return;
    }

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

    if (this.type === "herbivore") {
      const overlapsHerbivore = nearbyOrganisms(this.x, this.y, this.size + 10).some((other) =>
        other !== this && !other.dead && other.type === "herbivore" &&
        distanceSquared(this, other) < ((this.size + other.size) / 2 + 1) ** 2
      );
      if (overlapsHerbivore) {
        this.x = previousX;
        this.y = previousY;
        this.heading += random(-1, 1);
        this.turnTimer = random(.2, .6);
      }
    }

    if (this.type === "predator" && settings.plantsBlockPredators) {
      const blockedByPlant = nearbyOrganisms(this.x, this.y, this.size + 10).some((other) =>
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
    const predatorPopulation = this.type === "predator"
      ? organisms.reduce((count, organism) =>
        count + (!organism.dead && organism.type === "predator" ? 1 : 0), 0)
      : 0;
    for (const other of nearbyOrganisms(this.x, this.y, radius)) {
      if (other === this || other.dead || distanceSquared(this, other) > radius ** 2) continue;
      const canEatPlant = this.type === "herbivore" && this.eatCooldown <= 0 &&
        other.type === "plant" && canHerbivoreEatPlant(this, other);
      const canEatHerbivore = this.type === "predator" && this.eatCooldown <= 0 &&
        other.type === "herbivore" && canPredatorEatHerbivore(this, other);
      const canEatSmallerPredator = this.type === "predator" && this.eatCooldown <= 0 && other.type === "predator" &&
        predatorPopulation > 3 && other.level >= 2 && this.level >= other.level + settings.cannibalLevelGap;
      if (canEatPlant || canEatHerbivore || canEatSmallerPredator) {
        other.dead = true;
        if (this.type === "predator") {
          this.slowTimer = settings.predatorSlowDuration;
          this.eatCooldown = settings.predatorEatCooldown;
          if (canEatHerbivore) this.herbivoreMeals += 1;
        } else if (canEatPlant) {
          this.eatCooldown = settings.herbivoreEatCooldown;
          this.slowTimer = settings.herbivoreSlowDuration;
        }
        this.energy = Math.min(160, this.energy + (this.type === "predator" ? settings.predatorMealEnergy : 27));
        if (this.type === "predator") {
          this.predatorExperience += 1;
          const levelThreeThreshold = Math.max(settings.predatorLevel2Meals + 1, settings.predatorLevel3Meals);
          const earnedLevel = this.predatorExperience >= levelThreeThreshold
            ? 3
            : this.predatorExperience >= settings.predatorLevel2Meals ? 2 : 1;
          this.level = Math.min(settings.predatorMaxLevel, earnedLevel);
        } else {
          this.level = Math.min(settings.herbivoreMaxLevel, this.level + settings.herbivoreLevelGain);
        }
        if (this.type === "predator" && this.herbivoreMeals >= settings.predatorMealsPerOffspring &&
            canAddSpecies("predator")) {
          organisms.push(new Organism("predator", this.x + random(-8, 8), this.y + random(-8, 8)));
          this.herbivoreMeals = 0;
          this.energy *= .7;
        }
        return;
      }
      if (this.type === "herbivore" && other.type === "herbivore" &&
          this.level >= settings.herbivoreMatingLevel && other.level >= settings.herbivoreMatingLevel &&
          this.reproductionCooldown <= 0 && other.reproductionCooldown <= 0 &&
          this.energy > 45 && other.energy > 45 && canAddSpecies("herbivore")) {
        const centerX = (this.x + other.x) / 2;
        const centerY = (this.y + other.y) / 2;
        const averageParentEnergy = (this.energy + other.energy) / 2;
        const energyFitness = Math.max(0, Math.min(1, (averageParentEnergy - 45) / 115));
        const minimumLitter = Math.min(settings.herbivoreMinOffspring, settings.herbivoreMaxOffspring);
        const maximumLitter = Math.max(settings.herbivoreMinOffspring, settings.herbivoreMaxOffspring);
        const energyBasedLitter = minimumLitter + Math.round(energyFitness * (maximumLitter - minimumLitter));
        const availableSlots = availableSpeciesSlots("herbivore");
        const offspringCount = Math.min(energyBasedLitter, availableSlots);
        for (let i = 0; i < offspringCount; i++) {
          const offspring = createOpenOrganism("herbivore", centerX, centerY, 22);
          if (!offspring) continue;
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

  draw(lightweight = false) {
    const size = Math.max(2, Math.round(this.size));
    context.fillStyle = COLORS[this.type];
    context.shadowColor = COLORS[this.type];
    context.shadowBlur = lightweight ? 0 : (this.type === "plant" ? 3 : 7);
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
  canvas.width = Math.max(1, Math.floor(rect.width * settings.mapScale));
  canvas.height = Math.max(1, Math.floor(rect.height * settings.mapScale));
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
  chartDirty = true;
}

function getTotals() {
  const totals = { plant: 0, herbivore: 0, predator: 0 };
  organisms.forEach((organism) => { if (!organism.dead) totals[organism.type]++; });
  return totals;
}

function getLevelTotals() {
  const levels = { plant: {}, herbivore: {}, predator: {} };
  organisms.forEach((organism) => {
    if (organism.dead) return;
    const level = Math.max(1, Math.floor(organism.level));
    levels[organism.type][level] = (levels[organism.type][level] || 0) + 1;
  });
  return levels;
}

function levelColor(type, level, maxLevel) {
  const hex = COLORS[type].slice(1);
  const base = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const brightness = .08 + .62 * ((level - 1) / Math.max(1, maxLevel - 1));
  const mixed = base.map((channel) => Math.round(channel + (255 - channel) * brightness));
  return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
}

function positionIsOpen(type, x, y, size = 3) {
  const candidateSize = type === "plant" ? 8 : size;
  if (x < candidateSize || x > canvas.width - candidateSize || y < candidateSize || y > canvas.height - candidateSize) return false;
  return !organisms.some((other) => {
    if (other.dead || other.type !== type) return false;
    const otherSize = type === "plant" ? 8 : other.size;
    const minimumDistance = (candidateSize + otherSize) / 2 + 1;
    return (x - other.x) ** 2 + (y - other.y) ** 2 < minimumDistance ** 2;
  });
}

function createOpenOrganism(type, originX = null, originY = null, spread = 0) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const angle = random(0, Math.PI * 2);
    const radius = spread ? random(5, spread) : 0;
    const x = originX === null ? random(3, canvas.width - 3) : Math.max(3, Math.min(canvas.width - 3, originX + Math.cos(angle) * radius));
    const y = originY === null ? random(3, canvas.height - 3) : Math.max(3, Math.min(canvas.height - 3, originY + Math.sin(angle) * radius));
    if (positionIsOpen(type, x, y)) return new Organism(type, x, y);
  }
  return null;
}

function randomEdgePosition() {
  const margin = 5;
  const edge = Math.floor(random(0, 4));
  return {
    x: edge === 0 ? margin : edge === 1 ? canvas.width - margin : random(margin, canvas.width - margin),
    y: edge === 2 ? margin : edge === 3 ? canvas.height - margin : random(margin, canvas.height - margin),
  };
}

function createEdgeOrganism(type) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const { x, y } = randomEdgePosition();
    if (positionIsOpen(type, x, y)) return new Organism(type, x, y);
  }
  return null;
}

function scheduleMigration(type) {
  const average = type === "herbivore" ? settings.herbivoreMigrationInterval : settings.predatorMigrationInterval;
  const predatorCount = organisms.filter((organism) => !organism.dead && organism.type === "predator").length;
  const scarcityMultiplier = type === "predator" && predatorCount < 3 ? .3 : 1;
  migrationTimers[type] = random(average * .6, average * 1.4) * scarcityMultiplier;
}

function migrate(type) {
  const requested = type === "herbivore" ? settings.herbivoreMigrationCount : settings.predatorMigrationCount;
  const amount = Math.min(requested, availableSpeciesSlots(type));
  const packEntry = type === "herbivore" ? randomEdgePosition() : null;
  for (let i = 0; i < amount; i++) {
    const migrant = type === "herbivore"
      ? createOpenOrganism(type, packEntry.x, packEntry.y, 30)
      : createEdgeOrganism(type);
    if (migrant) organisms.push(migrant);
  }
  scheduleMigration(type);
}

function spawnPlant() {
  if (!canAddSpecies("plant")) return;
  const plants = organisms.filter((organism) => !organism.dead && organism.type === "plant");
  if (plants.length && Math.random() < settings.plantClusterChance) {
    const weightTotal = plants.reduce((sum, plant) => sum + plant.level ** 3, 0);
    let choice = random(0, weightTotal);
    let parent = plants[0];
    for (const plant of plants) {
      choice -= plant.level ** 3;
      if (choice <= 0) { parent = plant; break; }
    }
    const spread = Math.max(10, 46 - parent.level * 4);
    const maturity = (parent.level - 1) / Math.max(1, settings.plantPerpetualLevel - 1);
    const seedlingCount = 1 + Math.round(maturity * (settings.plantMaxSeedlings - 1));
    for (let i = 0; i < seedlingCount && canAddSpecies("plant"); i++) {
      const plant = createOpenOrganism("plant", parent.x, parent.y, spread) || createOpenOrganism("plant");
      if (plant) organisms.push(plant);
    }
  } else {
    const plant = createOpenOrganism("plant");
    if (plant) organisms.push(plant);
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
    const activeLevels = [...new Set(populationHistory.flatMap((point) =>
      Object.keys(point.levels?.[type] || {}).map(Number)
    ))].sort((a, b) => a - b);
    const highest = Math.max(1, ...populationHistory.flatMap((point) =>
      activeLevels.map((level) => point.levels?.[type]?.[level] || 0)
    ));
    const step = highest <= 10 ? 2 : highest <= 50 ? 10 : highest <= 200 ? 25 : highest <= 1000 ? 100 : 250;
    const ceiling = Math.max(step, Math.ceil(highest / step) * step);

    chartContext.textAlign = "left";
    chartContext.fillStyle = COLORS[type];
    chartContext.fillRect(left, top + 3 * ratio, 5 * ratio, 5 * ratio);
    chartContext.fillStyle = muted;
    chartContext.fillText(label, left + 9 * ratio, top + 6 * ratio);

    const legendStart = Math.max(left + 68 * ratio, width - right - activeLevels.length * 18 * ratio);
    chartContext.font = `${7 * ratio}px ui-monospace, monospace`;
    activeLevels.forEach((level, index) => {
      chartContext.fillStyle = levelColor(type, level, Math.max(...activeLevels, 1));
      chartContext.fillText(`L${level}`, legendStart + index * 18 * ratio, top + 6 * ratio);
    });
    chartContext.font = `${9 * ratio}px ui-monospace, monospace`;

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

    activeLevels.forEach((level) => {
      chartContext.strokeStyle = levelColor(type, level, Math.max(...activeLevels, 1));
      chartContext.lineWidth = (level === Math.max(...activeLevels) ? 1.8 : 1.2) * ratio;
      chartContext.lineJoin = "round";
      chartContext.beginPath();
      populationHistory.forEach((point, index) => {
        const x = left + (point.time - firstTime) / duration * innerWidth;
        const population = point.levels?.[type]?.[level] || 0;
        const y = plotTop + (1 - population / ceiling) * plotHeight;
        if (index === 0) chartContext.moveTo(x, y); else chartContext.lineTo(x, y);
      });
      chartContext.stroke();
    });
  });

  chartContext.fillStyle = muted;
  chartContext.textAlign = "left";
  chartContext.fillText(`${Math.floor(firstTime)}s`, left, height - 6 * ratio);
  chartContext.textAlign = "right";
  chartContext.fillText(`${Math.floor(lastTime)}s`, width - right, height - 6 * ratio);
}

function addPlantPatch(x, y, amount = 12) {
  for (let i = 0; i < amount && canAddSpecies("plant"); i++) {
    const plant = createOpenOrganism("plant", x, y, 28);
    if (plant) organisms.push(plant);
  }
}

function resetWorld(reason = "new_world") {
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
    for (let i = 0; i < amount && canAddSpecies(type); i++) {
      const organism = type === "predator" ? new Organism(type) : createOpenOrganism(type);
      if (organism) organisms.push(organism);
    }
  }
  scheduleMigration("herbivore");
  scheduleMigration("predator");
  updateStats();
  populationHistory.push({ time: 0, ...getTotals(), levels: getLevelTotals() });
  drawChart();
  chartDirty = false;
  trackAnalytics("life_simulation_started", {
    reason,
    starting_plants: settings.startingPlants,
    starting_herbivores: settings.startingHerbivores,
    starting_predators: settings.startingPredators,
  });
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
    migrationTimers.herbivore -= dt;
    migrationTimers.predator -= dt;
    const predatorCount = organisms.reduce((count, organism) =>
      count + (!organism.dead && organism.type === "predator" ? 1 : 0), 0);
    if (predatorCount < 3) {
      migrationTimers.predator = Math.min(migrationTimers.predator, settings.predatorMigrationInterval * .3);
    }
    while (plantSpawnTimer > settings.plantSpawnInterval && organisms.length < settings.maxPopulation) {
      plantSpawnTimer -= settings.plantSpawnInterval;
      spawnPlant();
    }
    if (migrationTimers.herbivore <= 0) migrate("herbivore");
    if (migrationTimers.predator <= 0) migrate("predator");
    buildSpatialIndex();
    organisms.slice().forEach((organism) => organism.update(dt));
    organisms = organisms.filter((organism) => !organism.dead);
    if (chartSampleTimer >= 1) {
      chartSampleTimer %= 1;
      populationHistory.push({ time: worldAge, ...getTotals(), levels: getLevelTotals() });
      chartDirty = true;
    }
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  const lightweightRendering = organisms.length >= 1500;
  organisms.forEach((organism) => organism.draw(lightweightRendering));
  updateStats();
  if (chartDirty) {
    drawChart();
    chartDirty = false;
  }
  requestAnimationFrame(frame);
}

pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume" : "Pause";
  trackAnalytics("life_simulation_pause_toggled", { paused, world_age_seconds: Math.round(worldAge) });
});
resetButton.addEventListener("click", resetWorld);
speedInput.addEventListener("input", () => {
  speed = Number(speedInput.value);
  speedOutput.textContent = `${speed}×`;
});
speedInput.addEventListener("change", () => {
  trackAnalytics("life_simulation_speed_changed", { speed });
});
document.querySelector("#settingsButton").addEventListener("click", () => {
  settingsDialog.showModal();
  trackAnalytics("life_panel_opened", { panel: "settings" });
});
document.querySelector("#rulesButton").addEventListener("click", () => {
  rulesDialog.showModal();
  trackAnalytics("life_panel_opened", { panel: "rules" });
});
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
    if (key === "mapScale") resizeCanvas();
  });
});
document.querySelector("#saveDefaultsButton").addEventListener("click", (event) => {
  localStorage.setItem("pixelLifeSettings", JSON.stringify(settings));
  const button = event.currentTarget;
  button.textContent = "Defaults saved";
  setTimeout(() => { button.textContent = "Save as defaults"; }, 1600);
  trackAnalytics("life_settings_saved", { settings_count: Object.keys(settings).length });
});
canvas.addEventListener("pointerdown", (event) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  addPlantPatch((event.clientX - rect.left) * scaleX, (event.clientY - rect.top) * scaleY);
  trackAnalytics("life_plant_patch_added", { world_age_seconds: Math.round(worldAge) });
});
window.addEventListener("resize", () => { resizeCanvas(); resizeChart(); });

resizeCanvas();
resizeChart();
resetWorld("initial_load");
requestAnimationFrame(frame);
