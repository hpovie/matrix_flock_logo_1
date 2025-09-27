// Configuration (adjusted for better detail preservation)
const config = {
    particleSize: 1.0,
    mouseRadius: 50,
    mouseStrength: 200,
    morphSpeed: 0.05,
    deltaLogoScale: 0.055,
    deltaColorBoost: 1.1,
    deltaZSpread: 0.15,
    deltaYOffset: 1.5,
    matrixLogoScale: 0.18,
    matrixYOffset: 0,
    matrixZSpread: 0.1,
    cameraZoomFactor: 1.5,
    textureSize: 256,
    separationDistance: 20.0,
    alignmentDistance: 20.0,
    cohesionDistance: 20.0,
    freedomFactor: 0.75,
    bounds: 100,
    speedLimit: 9.0
};
config.particleCount = config.textureSize * config.textureSize;

// Flocking timing constants
const FLOCKING_DURATION = 8.0;
const TRANSITION_DURATION = 5.0;
const TOTAL_FLOCKING_TIME = FLOCKING_DURATION + TRANSITION_DURATION;

// State
let currentLogo = 'matrix';
let isMorphing = false;
let isIdle = true;
let isFlocking = false;
let targetPositions = null;
let flockingStartTime = null;
let flockingPhase = "idle";
let morphStartTime = null;

// Three.js setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// GPGPU Setup
const gpgpu = {
    positionTextures: [],
    velocityTextures: [],
    positionTargets: [],
    velocityTargets: [],
    simulationUniforms: {
        positions: { value: null },
        velocities: { value: null },
        originalPositions: { value: null },
        targetPositions: { value: null },
        mousePosition: { value: new THREE.Vector3(-1000, -1000, -1000) },
        mouseRadius: { value: config.mouseRadius },
        mouseStrength: { value: config.mouseStrength },
        morphProgress: { value: 0 },
        morphSpeed: { value: config.morphSpeed },
        deltaTime: { value: 0 },
        isMorphing: { value: false },
        isIdle: { value: true },
        isFlocking: { value: false },
        separationDistance: { value: config.separationDistance },
        alignmentDistance: { value: config.alignmentDistance },
        cohesionDistance: { value: config.cohesionDistance },
        freedomFactor: { value: config.freedomFactor },
        bounds: { value: config.bounds },
        speedLimit: { value: config.speedLimit },
        time: { value: 0 },
        returnForceStrength: { value: 0 }
    },
    renderUniforms: {
        positions: { value: null },
        startColors: { value: null },
        targetColors: { value: null },
        sizes: { value: null },
        particleSize: { value: config.particleSize },
        colorMix: { value: 0 },
        time: { value: 0 },
        colorStartTime: { value: 0 }
    }
};

// Helper function to copy texture to render target
function copyTextureToRenderTarget(texture, renderTarget) {
    const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ map: texture })
    );
    const scene = new THREE.Scene();
    scene.add(quad);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
}

// Create data texture
function createDataTexture(size, data = null) {
    if (!data) {
        data = new Float32Array(size * size * 4);
        for (let i = 0; i < size * size * 4; i++) {
            data[i] = 0;
        }
    }
    const texture = new THREE.DataTexture(
        data, size, size, 
        THREE.RGBAFormat, THREE.FloatType
    );
    texture.needsUpdate = true;
    return texture;
}

function initGPGPU() {
    const size = config.textureSize;
    
    // Create position textures (ping-pong)
    gpgpu.positionTextures[0] = createDataTexture(size);
    gpgpu.positionTextures[1] = createDataTexture(size);
    
    // Create velocity textures (ping-pong)
    gpgpu.velocityTextures[0] = createDataTexture(size);
    gpgpu.velocityTextures[1] = createDataTexture(size);
    
    // Create render targets
    for (let i = 0; i < 2; i++) {
        gpgpu.positionTargets[i] = new THREE.WebGLRenderTarget(
            size, size, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                format: THREE.RGBAFormat,
                type: THREE.FloatType,
                stencilBuffer: false
            }
        );
        
        gpgpu.velocityTargets[i] = new THREE.WebGLRenderTarget(
            size, size, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                format: THREE.RGBAFormat,
                type: THREE.FloatType,
                stencilBuffer: false
            }
        );
    }
    
    // Set initial uniforms
    gpgpu.simulationUniforms.originalPositions.value = null;
    gpgpu.simulationUniforms.targetPositions.value = null;
    gpgpu.simulationUniforms.mousePosition.value.set(-1000, -1000, -1000);
    gpgpu.simulationUniforms.mouseRadius.value = config.mouseRadius;
    gpgpu.simulationUniforms.mouseStrength.value = config.mouseStrength;
    gpgpu.simulationUniforms.morphProgress.value = 0;
    gpgpu.simulationUniforms.morphSpeed.value = config.morphSpeed;
    gpgpu.simulationUniforms.deltaTime.value = 0;
    gpgpu.simulationUniforms.isMorphing.value = false;
    gpgpu.simulationUniforms.positions.value = gpgpu.positionTextures[0];
    gpgpu.simulationUniforms.velocities.value = gpgpu.velocityTextures[0];
    gpgpu.simulationUniforms.isIdle.value = true;
    gpgpu.simulationUniforms.isFlocking.value = false;
    gpgpu.simulationUniforms.time.value = 0;
    
    // Set initial render uniforms
    gpgpu.renderUniforms.time.value = 0;
    gpgpu.renderUniforms.colorStartTime.value = 0;
    
    // Simulation materials
    gpgpu.velocityMaterial = new THREE.ShaderMaterial({
        uniforms: gpgpu.simulationUniforms,
        vertexShader: simulationVertexShader,
        fragmentShader: velocityFragmentShader
    });

    gpgpu.positionMaterial = new THREE.ShaderMaterial({
        uniforms: gpgpu.simulationUniforms,
        vertexShader: simulationVertexShader,
        fragmentShader: positionFragmentShader
    });
    
    // Fullscreen quad & scene/camera for sim passes
    gpgpu.simulationMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gpgpu.velocityMaterial);
    gpgpu.simulationScene = new THREE.Scene();
    gpgpu.simulationScene.add(gpgpu.simulationMesh);
    gpgpu.simulationCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // Create render material
    gpgpu.renderMaterial = new THREE.ShaderMaterial({
        uniforms: gpgpu.renderUniforms,
        vertexShader: renderVertexShader,
        fragmentShader: renderFragmentShader,
        transparent: true,
        blending: THREE.NormalBlending
    });
    
    // Create particle system
    const particlesGeometry = new THREE.BufferGeometry();
    const particleCount = config.particleCount;
    
    // Create indices for the particles
    const indices = new Uint32Array(particleCount);
    for (let i = 0; i < particleCount; i++) indices[i] = i;
    
    // Create UV coordinates for texture lookup
    const uvs = new Float32Array(particleCount * 2);
    for (let i = 0; i < particleCount; i++) {
        const x = (i % config.textureSize) / config.textureSize;
        const y = Math.floor(i / config.textureSize) / config.textureSize;
        uvs[i * 2] = x;
        uvs[i * 2 + 1] = y;
    }
    
    particlesGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    particlesGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    particlesGeometry.setDrawRange(0, particleCount);
    
    gpgpu.particleSystem = new THREE.Points(particlesGeometry, gpgpu.renderMaterial);
    scene.add(gpgpu.particleSystem);
}

const simulationVertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const velocityFragmentShader = `
    precision highp float;

    uniform sampler2D positions;
    uniform sampler2D velocities;
    uniform sampler2D originalPositions;
    uniform sampler2D targetPositions;

    uniform vec3  mousePosition;
    uniform float mouseRadius;
    uniform float mouseStrength;

    uniform float morphProgress;
    uniform float deltaTime;
    uniform bool  isMorphing;
    uniform bool  isIdle;
    uniform bool  isFlocking;

    uniform float separationDistance;
    uniform float alignmentDistance;
    uniform float cohesionDistance;
    uniform float freedomFactor;
    uniform float bounds;
    uniform float speedLimit;
    uniform float time;

    uniform float returnForceStrength;

    varying vec2 vUv;

    const float PI = 3.141592653589793;
    const float PI_2 = PI * 2.0;
    const float textureSize = ${config.textureSize}.0;

    float zoneRadius = 40.0;
    float zoneRadiusSquared = 1600.0;

    float separationThresh = 0.45;
    float alignmentThresh = 0.65;

    float rand(vec2 co) {
        return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453);
    }

    void main() {
        vec3 pos = texture2D(positions, vUv).xyz;
        vec4 vel4 = texture2D(velocities, vUv);
        vec3 vel = vel4.xyz;
        float maxLife = max(vel4.w, 1.0);

        vec3 homePos   = texture2D(originalPositions, vUv).xyz;
        vec3 targetPos = isMorphing ? texture2D(targetPositions, vUv).xyz : homePos;

        // Morph easing
        float t = clamp(morphProgress / 3.0, 0.0, 1.0);
        float delay = fract(sin(dot(vUv, vec2(91.345, 47.853))) * 43758.5453) * 0.5;
        float particleT = clamp((t - delay) / (1. - delay), 0.0, 1.0);
        float easedT = particleT * particleT * (3.0 - 2.0 * particleT);

        // Attraction toward target
        vec3 desire = (isMorphing ? targetPos : homePos) - pos;

        // Weak baseline pull during morphing
        float attractStrength = isMorphing ? 0.01 : 0.05;

        // Only apply return force strength when flocking is enabled and in progress
        if (isFlocking) {
            // Ramp up pull strength as returnForceStrength grows
            attractStrength += returnForceStrength * (0.9 * easedT + 0.1);
        } else if (isMorphing) {
            // Normal morphing behavior without flocking return force
            attractStrength += 0.1 * easedT;
        }

        vel += desire * attractStrength;

        // Mouse interaction
        float distToMouse = distance(pos, mousePosition);
        
        // IDLE STATE: Mouse repulsion with particle respawn
        if (isIdle && !isMorphing && distToMouse < mouseRadius) {
            vec3 dir = normalize(pos - mousePosition);
            float force = (mouseRadius - distToMouse) / mouseRadius * mouseStrength;
            vel += dir * force;
            
            // Check if particle should "die" and respawn
            float distFromHome = distance(pos, homePos);
            if (distFromHome > mouseRadius * 1.5) {
                // Signal respawn by setting alpha > 1.5
                gl_FragColor = vec4(0.0, 0.0, 0.0, 2.0);
                return;
            }
        }
        
        // FLOCKING STATE: Predator avoidance
        else if (isFlocking && isMorphing && distToMouse < mouseRadius * 2.0) {
            vec3 fleeDir = normalize(pos - mousePosition);
            float force = (mouseRadius * 2.0 - distToMouse) / (mouseRadius * 2.0) * mouseStrength * 0.5;
            vel += fleeDir * force;
        }

        // Flocking forces
        if (isFlocking && isMorphing && particleT > 0.2 && particleT < 0.8) {
            zoneRadius = separationDistance + alignmentDistance + cohesionDistance;
            separationThresh = separationDistance / zoneRadius;
            alignmentThresh = (separationDistance + alignmentDistance) / zoneRadius;
            zoneRadiusSquared = zoneRadius * zoneRadius;

            if (length(pos) > bounds) {
                vel -= normalize(pos) * deltaTime * 5.0;
            }

            for (float y = 0.0; y < textureSize; y += 4.0) {
                for (float x = 0.0; x < textureSize; x += 4.0) {
                    vec2 ref = vec2(x + 0.5, y + 0.5) / textureSize;
                    if (distance(ref, vUv) < 0.001) continue;

                    vec3 otherPos = texture2D(positions, ref).xyz;
                    vec3 otherVel = texture2D(velocities, ref).xyz;

                    vec3 dir = otherPos - pos;
                    float dist = length(dir);
                    if (dist < 0.0001) continue;

                    float distSquared = dist * dist;
                    if (distSquared > zoneRadiusSquared) continue;

                    float percent = distSquared / zoneRadiusSquared;

                    // Separation - increased by 50%
                    if (percent < separationThresh) {
                        float f = (separationThresh / percent - 1.0) * deltaTime * 1.5;
                        vel -= normalize(dir) * f;
                    }
                    // Alignment - increased by 30%
                    else if (percent < alignmentThresh) {
                        float threshDelta = alignmentThresh - separationThresh;
                        float adjustedPercent = (percent - separationThresh) / threshDelta;
                        float f = (0.5 - cos(adjustedPercent * PI_2) * 0.5 + 0.5) * deltaTime * 1.3;
                        vel += normalize(otherVel) * f;
                    }
                    // Cohesion - increased by 40%
                    else {
                        float threshDelta = 1.0 - alignmentThresh;
                        float adjustedPercent = (threshDelta == 0.0) ? 1.0 : (percent - alignmentThresh) / threshDelta;
                        float f = (0.5 - (cos(adjustedPercent * PI_2) * -0.5 + 0.5)) * deltaTime * 1.4;
                        vel += normalize(dir) * f;
                    }
                }
            }

            if (length(vel) > speedLimit) {
                vel = normalize(vel) * speedLimit;
            }
        }

        vel *= 0.90; // damping
        gl_FragColor = vec4(vel, maxLife);
    }
`;

const positionFragmentShader = `
    precision highp float;

    uniform sampler2D positions;
    uniform sampler2D velocities;
    uniform sampler2D originalPositions;
    uniform float deltaTime;

    varying vec2 vUv;

    void main() {
        vec4 pos4 = texture2D(positions, vUv);
        vec3 pos = pos4.xyz;
        float life = pos4.w;

        vec4 vel4 = texture2D(velocities, vUv);
        vec3 vel = vel4.xyz;
        
        // Check if particle should respawn (velocity alpha > 1.5 indicates respawn)
        if (vel4.a > 1.5) {
            vec3 homePos = texture2D(originalPositions, vUv).xyz;
            gl_FragColor = vec4(homePos, 1.0);
        } else {
            // Integrate
            pos += vel * deltaTime;
            
            // Keep alpha/life stable and visible
            life = 1.0;
            gl_FragColor = vec4(pos, life);
        }
    }
`;

const renderVertexShader = `
precision highp float;

uniform sampler2D positions;
uniform sampler2D startColors;
uniform sampler2D targetColors;
uniform sampler2D sizes;
uniform float particleSize;
uniform float colorMix;
uniform float time;
uniform float colorStartTime;

varying vec4 vColor;
varying float vSize;

float rand(vec2 co) {
    return fract(sin(dot(co.xy, vec2(12.9898,78.233))) * 43758.5453);
}

void main() {
    vec4 positionData = texture2D(positions, uv);
    vec3 pos = positionData.xyz;
    float life = positionData.w;

    // Sample both color sources
    vec4 c1 = texture2D(startColors, uv);
    vec4 c2 = texture2D(targetColors, uv);

    // === PER-PARTICLE RANDOM TIMING USING ELAPSED TIME SINCE COLOR START ===
    float elapsedTime = time - colorStartTime;
    float randVal = rand(uv);
    
    // Each particle has its own random switch time between 1.0s and 2.5s after color start
    float particleSwitchTime = 1.0 + randVal * 1.5;
    
    // Particle transitions when elapsed time reaches its switch time
    float particleTransition = smoothstep(particleSwitchTime - 0.3, particleSwitchTime + 0.3, elapsedTime);
    
    // Global colorMix override ensures completion 0.5s before settling
    float finalTransition = max(particleTransition, colorMix);
    
    // Smoothly mix colors
    vColor = mix(c1, c2, finalTransition);

    float sizeData = texture2D(sizes, uv).r;
    vSize = particleSize * sizeData;

    vColor.a = clamp(life, 0.0, 1.0);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = vSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
}
`;

const renderFragmentShader = `
precision highp float;

varying vec4 vColor;
varying float vSize;

void main() {
    // Improved circular point with anti-aliasing
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);
    
    // Smooth falloff at edges for anti-aliasing
    float alpha = 1.0 - smoothstep(0.4, 0.5, dist);
    
    // Discard fully transparent fragments
    if (alpha < 0.01) discard;
    
    // Apply color with alpha
    gl_FragColor = vec4(vColor.rgb, vColor.a * alpha);
    
    // Add a subtle highlight for better depth perception
    float highlight = pow(1.0 - dist * 1.8, 4.0) * 0.2;
    gl_FragColor.rgb += highlight;
}
`;

function positionCamera() {
    camera.position.z = 80;  
    camera.lookAt(0, 0, 0);
}

// Utility: Load image and extract pixel data
function loadImageData(url) {
    return new Promise((resolve, reject) => {
        new THREE.TextureLoader().load(url, texture => {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            const img = texture.image;

            canvas.width = img.width;
            canvas.height = img.height;
            context.drawImage(img, 0, 0, img.width, img.height);

            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            resolve({
                canvas,
                context,
                data: imageData.data,
                width: canvas.width,
                height: canvas.height
            });
        }, undefined, reject);
    });
}

function processLogoData(data, logoType) {
    const points = [];
    const dataArray = data.data;
    const scale = logoType === 'matrix' ? config.matrixLogoScale : config.deltaLogoScale;
    const zSpread = logoType === 'matrix' ? config.matrixZSpread : config.deltaZSpread;

    // First pass: collect all valid points with more precise sampling
    for (let y = 0; y < data.height; y += 1) {
        for (let x = 0; x < data.width; x += 1) {
            const index = (y * data.width + x) * 4;
            const r = dataArray[index];
            const g = dataArray[index + 1];
            const b = dataArray[index + 2];
            const a = dataArray[index + 3];

            // Skip transparent/near-white pixels with more precise threshold
            // For Matrix logo, be more selective to preserve fine details
            if (logoType === 'matrix') {
                // Matrix logo has fine details, so use a lower threshold
                if (a <= 30 || (r > 230 && g > 230 && b > 230)) continue;
            } else {
                // Delta logo can use the standard threshold
                if (a <= 20 || (r > 240 && g > 240 && b > 240)) continue;
            }

            let normalizedR = r / 255;
            let normalizedG = g / 255;
            let normalizedB = b / 255;

            if (logoType === 'delta') {
                normalizedR = Math.min(normalizedR * config.deltaColorBoost, 1.0);
                normalizedG = Math.min(normalizedG * config.deltaColorBoost, 1.0);
                normalizedB = Math.min(normalizedB * config.deltaColorBoost, 1.0);
            }

            // Reduced jitter for crisper appearance
            const jitter = logoType === 'matrix' ? 0.01 : 0.02; // Even less jitter for Matrix
            const px = ((x - data.width / 2) + (Math.random() - 0.5) * jitter) * scale;
            const py = ((data.height / 2 - y) + (Math.random() - 0.5) * jitter) * scale
                       + (logoType === 'delta' ? config.deltaYOffset : config.matrixYOffset);
            const pz = (Math.random() - 0.5) * zSpread;

            // More consistent sizing for crisper appearance
            // For Matrix logo, use smaller particles to preserve fine details
            const size = logoType === 'matrix' 
                ? 0.8 + (1 - (normalizedR + normalizedG + normalizedB) / 3) * 0.2  // Smaller variation for Matrix
                : 1.0;  // Consistent size for Delta

            // store original image coords (ix,iy) too for stratified bucketing
            points.push({
                x: px,
                y: py,
                z: pz,
                r: normalizedR,
                g: normalizedG,
                b: normalizedB,
                size: size,
                ix: x,
                iy: y,
                brightness: (normalizedR + normalizedG + normalizedB) / 3
            });
        }
    }

    const size = config.textureSize;
    const positionArray = new Float32Array(size * size * 4);
    const colorArray = new Float32Array(size * size * 4);
    const sizeArray = new Float32Array(size * size * 4);

    // ---------- NEW: Stratified + weighted sampling for maximum smoothness ----------
    if (points.length > 0) {

        // Helper: Fisher-Yates shuffle
        function fisherYatesShuffle(arr) {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
        }

        // If matrix: perform stratified bucketing (2D grid) and sample per-bucket
        if (logoType === 'matrix') {
            const BUCKETS = 32; // 32x32 grid; tune if needed (higher -> finer stratification)
            const buckets = new Array(BUCKETS);
            for (let i = 0; i < BUCKETS; i++) {
                buckets[i] = new Array(BUCKETS);
                for (let j = 0; j < BUCKETS; j++) buckets[i][j] = [];
            }

            // Build buckets using original image coordinates (ix,iy)
            for (let p of points) {
                const bx = Math.floor((p.ix / data.width) * BUCKETS);
                const by = Math.floor((p.iy / data.height) * BUCKETS);
                const ix = Math.min(BUCKETS - 1, Math.max(0, bx));
                const iy = Math.min(BUCKETS - 1, Math.max(0, by));
                buckets[ix][iy].push(p);
            }

            // Optionally weight edge / bright pixels slightly by duplicating entries
            // Determine which points are "edge-like" (bright)
            const weightFactor = 2; // set to 1 for no weighting; >1 emphasizes bright/edge pixels
            // Count total candidate points
            let totalPoints = points.length;

            // Compute quota per bucket proportional to bucket size
            const bucketQuotas = [];
            let assignedTotal = 0;

            for (let i = 0; i < BUCKETS; i++) {
                for (let j = 0; j < BUCKETS; j++) {
                    const count = buckets[i][j].length;
                    bucketQuotas.push({
                        i, j, count,
                        quota: Math.max(0, Math.round((count / totalPoints) * config.particleCount))
                    });
                    assignedTotal += Math.max(0, Math.round((count / totalPoints) * config.particleCount));
                }
            }

            // Fix rounding remainder
            let remainder = config.particleCount - assignedTotal;
            // Sort buckets by count descending to distribute remainder to densest buckets first
            bucketQuotas.sort((a,b) => b.count - a.count);
            let k = 0;
            while (remainder > 0 && k < bucketQuotas.length) {
                bucketQuotas[k].quota += 1;
                remainder -= 1;
                k++;
                if (k >= bucketQuotas.length) k = 0;
            }

            // Now sample from each bucket (shuffle bucket, pick quota)
            const selected = [];
            for (let bq of bucketQuotas) {
                const bx = bq.i, by = bq.j;
                const arr = buckets[bx][by];
                if (arr.length === 0) continue;

                // Expand weighted list: duplicate bright/edge-ish points
                const weighted = [];
                for (let p of arr) {
                    const times = (p.brightness > 0.8) ? weightFactor : 1;
                    for (let t = 0; t < times; t++) weighted.push(p);
                }

                // If weighted ended up empty (shouldn't), fallback to arr
                const pool = weighted.length > 0 ? weighted : arr.slice();

                fisherYatesShuffle(pool);

                // Pick up to quota (allow sampling with replacement if needed)
                for (let n = 0; n < bq.quota; n++) {
                    if (pool.length === 0) break;
                    // Choose element (wrapping index if quota > pool.length)
                    const p = pool[n % pool.length];
                    selected.push(p);
                }
            }

            // If we still have too few selected (some buckets empty), fill from global pool
            if (selected.length < config.particleCount) {
                // Build a global weighted pool and shuffle
                const global = [];
                for (let p of points) {
                    const times = (p.brightness > 0.8) ? weightFactor : 1;
                    for (let t = 0; t < times; t++) global.push(p);
                }
                fisherYatesShuffle(global);

                let i = 0;
                while (selected.length < config.particleCount && global.length > 0) {
                    selected.push(global[i % global.length]);
                    i++;
                    // if i grows too large, it will just wrap but that's fine as fallback
                }
            }

            // If we somehow overshot (due to quotas rounding), trim
            if (selected.length > config.particleCount) {
                selected.length = config.particleCount;
            }

            // Final shuffle of the selected points to remove any remaining ordering bias
            fisherYatesShuffle(selected);

            // Write into textures with small jitter
            const extraJitter = 0.02;
            for (let i = 0; i < config.particleCount; i++) {
                const point = selected[i % selected.length];

                positionArray[i * 4] = point.x + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 1] = point.y + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 2] = point.z + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 3] = 1.0;

                colorArray[i * 4] = point.r;
                colorArray[i * 4 + 1] = point.g;
                colorArray[i * 4 + 2] = point.b;
                colorArray[i * 4 + 3] = 1.0;

                sizeArray[i * 4] = point.size;
            }

        } else {
            // For Delta logo, use the standard distribution (shuffled indices) but keep unchanged behavior
            const repetitions = Math.ceil(config.particleCount / points.length);
            
            // Create a shuffled index array to avoid spatial correlation
            const indices = [];
            for (let i = 0; i < points.length; i++) indices.push(i);
            
            // Fisher-Yates shuffle
            for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [indices[i], indices[j]] = [indices[j], indices[i]];
            }
            
            // Distribute points evenly
            for (let i = 0; i < config.particleCount; i++) {
                const pointIndex = indices[i % points.length];
                const point = points[pointIndex];
                
                // Add additional jitter for repeated points to avoid exact overlap
                const extraJitter = (i >= points.length) ? 0.1 : 0;
                
                positionArray[i * 4] = point.x + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 1] = point.y + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 2] = point.z + (Math.random() - 0.5) * extraJitter;
                positionArray[i * 4 + 3] = 1.0;

                colorArray[i * 4] = point.r;
                colorArray[i * 4 + 1] = point.g;
                colorArray[i * 4 + 2] = point.b;
                colorArray[i * 4 + 3] = 1.0;

                sizeArray[i * 4] = point.size;
            }
        }
    }

    const positionTexture = createDataTexture(size, positionArray);
    const colorTexture = createDataTexture(size, colorArray);
    const sizeTexture = createDataTexture(size, sizeArray);

    if (logoType === 'matrix') {
        gpgpu.matrixPositionTexture = positionTexture;
        gpgpu.matrixColorTexture = colorTexture;
        gpgpu.matrixSizeTexture = sizeTexture;
    } else {
        gpgpu.deltaPositionTexture = positionTexture;
        gpgpu.deltaColorTexture = colorTexture;
        gpgpu.deltaSizeTexture = sizeTexture;
    }
}

function initParticles(matrixData, deltaData) {
    // Process logo data into textures
    processLogoData(matrixData, 'matrix');
    processLogoData(deltaData, 'delta');
    
    // Verify textures were created
    if (!gpgpu.matrixPositionTexture || !gpgpu.deltaPositionTexture) {
        console.error("Failed to create logo textures");
        return;
    }
    
    // Set initial positions (Matrix first)
    gpgpu.simulationUniforms.originalPositions.value = gpgpu.matrixPositionTexture;
    
    // Copy initial positions to simulation texture (both ping-pong buffers)
    copyTextureToRenderTarget(gpgpu.simulationUniforms.originalPositions.value, gpgpu.positionTargets[0]);
    copyTextureToRenderTarget(gpgpu.simulationUniforms.originalPositions.value, gpgpu.positionTargets[1]);
    
    // Initialize velocities to zero
    const zeroTexture = createDataTexture(config.textureSize);
    copyTextureToRenderTarget(zeroTexture, gpgpu.velocityTargets[0]);
    copyTextureToRenderTarget(zeroTexture, gpgpu.velocityTargets[1]);
    
    // Set render uniforms
    gpgpu.renderUniforms.positions.value = gpgpu.positionTargets[0].texture;

    // At startup, both start & target colors are the same (Matrix logo first)
    gpgpu.renderUniforms.startColors.value = gpgpu.matrixColorTexture;
    gpgpu.renderUniforms.targetColors.value = gpgpu.matrixColorTexture;

    gpgpu.renderUniforms.sizes.value = gpgpu.matrixSizeTexture;
    gpgpu.renderUniforms.colorMix.value = 0.0;
}

// Mouse interaction
const mouse = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let mouseWorldPos = new THREE.Vector3(-1000, -1000, -1000);

window.addEventListener('mousemove', (event) => {
    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    
    // Update raycaster
    raycaster.setFromCamera(mouse, camera);
    
    // Create a temporary sphere for intersection testing
    const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
    const ray = new THREE.Ray();
    raycaster.ray.copy(ray);
    
    if (ray.intersectSphere(sphere, mouseWorldPos)) {
        mouseWorldPos.multiplyScalar(50);
    } else {
        mouseWorldPos.set(-1000, -1000, -1000);
    }
});

window.addEventListener('click', () => {
    if (isMorphing) return;

    // Begin morphing
    isIdle = false;
    isMorphing = true;

    gpgpu.simulationUniforms.isIdle.value = false;
    gpgpu.simulationUniforms.isMorphing.value = true;

    // Remember the old logo before flipping
    const previousLogo = currentLogo;

    // Flip current logo
    currentLogo = currentLogo === 'matrix' ? 'delta' : 'matrix';
    gpgpu.simulationUniforms.morphProgress.value = 0;

    // Set target positions
    gpgpu.simulationUniforms.targetPositions.value =
        currentLogo === 'matrix'
            ? gpgpu.matrixPositionTexture
            : gpgpu.deltaPositionTexture;

    // === RESET COLOR START TIME ===
    gpgpu.renderUniforms.colorStartTime.value = gpgpu.simulationUniforms.time.value;

    // Old colors → start
    gpgpu.renderUniforms.startColors.value =
        previousLogo === 'matrix'
            ? gpgpu.matrixColorTexture
            : gpgpu.deltaColorTexture;

    // New colors → target
    gpgpu.renderUniforms.targetColors.value =
        currentLogo === 'matrix'
            ? gpgpu.matrixColorTexture
            : gpgpu.deltaColorTexture;

    // Reset color mix progression
    gpgpu.renderUniforms.colorMix.value = 0;

    // Sizes stay as-is (still linked to target logo)
    gpgpu.renderUniforms.sizes.value =
        currentLogo === 'matrix'
            ? gpgpu.matrixSizeTexture
            : gpgpu.deltaSizeTexture;

    // Track morph + flocking timing
    morphStartTime = performance.now();
    flockingStartTime = performance.now();
    flockingPhase = "flocking";

    // Update button text
    const toggleLogoButton = document.getElementById('toggleLogo');
    if (toggleLogoButton) {
        toggleLogoButton.textContent =
            `Switch to ${currentLogo === 'matrix' ? 'Delta' : 'Matrix'} Logo`;
    }

    // Disable mouse interaction during morph
    gpgpu.simulationUniforms.mousePosition.value.set(-1000, -1000, -1000);
});

// UI event handlers
document.getElementById('toggleLogo').addEventListener('click', () => {
    window.dispatchEvent(new Event('click'));
});

document.getElementById('toggleFlocking').addEventListener('click', function() {
    isFlocking = !isFlocking;
    gpgpu.simulationUniforms.isFlocking.value = isFlocking;
    this.textContent = isFlocking ? 'Disable Flocking' : 'Enable Flocking';
    
    // Start/stop flocking timer based on state
    if (isFlocking) {
        flockingStartTime = performance.now();
        flockingPhase = "flocking";
    } else {
        flockingPhase = "idle";
        gpgpu.simulationUniforms.returnForceStrength.value = 0.0;
        
        // Reset to normal morphing behavior if currently morphing
        if (isMorphing) {
            gpgpu.simulationUniforms.originalPositions.value = 
                currentLogo === 'matrix' 
                    ? gpgpu.matrixPositionTexture 
                    : gpgpu.deltaPositionTexture;
        }
    }
});

// Animation loop
const clock = new THREE.Clock();
let currentPositionTarget = 0;
let currentVelocityTarget = 0;

function animate() {
    requestAnimationFrame(animate);

    const deltaTime = clock.getDelta();

    // === Update shared uniforms ===
    gpgpu.simulationUniforms.deltaTime.value = deltaTime;
    gpgpu.simulationUniforms.time.value += deltaTime;
    
    // UPDATE RENDER TIME UNIFORM
    gpgpu.renderUniforms.time.value = gpgpu.simulationUniforms.time.value;

    // === Update mouse interaction ===
    if (!isMorphing && isIdle) {
        // Enable mouse interaction in idle state
        gpgpu.simulationUniforms.mousePosition.value.copy(mouseWorldPos);
    } else if (isFlocking && isMorphing) {
        // Enable mouse interaction as predator in flocking state
        gpgpu.simulationUniforms.mousePosition.value.copy(mouseWorldPos);
    } else {
        // Disable mouse interaction
        gpgpu.simulationUniforms.mousePosition.value.set(-1000, -1000, -1000);
    }

    // === Update flocking phase ===
    if (isFlocking && flockingPhase === "flocking") {
        const elapsed = (performance.now() - flockingStartTime) / 1000;
        
        if (elapsed < FLOCKING_DURATION) {
            // Free flocking phase - no return force
            gpgpu.simulationUniforms.returnForceStrength.value = 0.0;
        } else if (elapsed < TOTAL_FLOCKING_TIME) {
            // Transition phase - ramp up return force
            const t = (elapsed - FLOCKING_DURATION) / TRANSITION_DURATION;
            gpgpu.simulationUniforms.returnForceStrength.value = t;
        } else {
            // Settled phase - full return force
            gpgpu.simulationUniforms.returnForceStrength.value = 1.0;
            flockingPhase = "settled";
        }
    } else if (!isFlocking && flockingPhase !== "idle") {
        // Reset if flocking is disabled
        flockingPhase = "idle";
        gpgpu.simulationUniforms.returnForceStrength.value = 0.0;
    }

    // === Color mix update ===
    if (isMorphing && !isFlocking) {
        // Morphing only
        const elapsed = (performance.now() - morphStartTime) / 1000;

        // Colors finish 0.5s before morph ends
        const cutoff = Math.max(0.1, TRANSITION_DURATION - 0.5);
        const t = Math.min(elapsed / cutoff, 1.0);

        gpgpu.renderUniforms.colorMix.value = t;

    } else if (isMorphing && isFlocking && flockingPhase === "flocking") {
        // Morphing with flocking
        const elapsed = (performance.now() - flockingStartTime) / 1000;

        // Colors finish 0.5s before flocking ends
        const cutoff = Math.max(0.1, TOTAL_FLOCKING_TIME - 0.5);
        const t = Math.min(elapsed / cutoff, 1.0);

        gpgpu.renderUniforms.colorMix.value = t;

    } else if (flockingPhase === "settled" || (!isMorphing && !isIdle)) {
        // Once settled, enforce fully switched
        gpgpu.renderUniforms.colorMix.value = 1.0;
    }

    // === Ping-pong ===
    const nextPositionTarget = 1 - currentPositionTarget;
    const nextVelocityTarget = 1 - currentVelocityTarget;

    // Pass 1: Velocity update
    gpgpu.simulationUniforms.positions.value  = gpgpu.positionTargets[currentPositionTarget].texture;
    gpgpu.simulationUniforms.velocities.value = gpgpu.velocityTargets[currentVelocityTarget].texture;
    gpgpu.simulationMesh.material = gpgpu.velocityMaterial;
    renderer.setRenderTarget(gpgpu.velocityTargets[nextVelocityTarget]);
    renderer.render(gpgpu.simulationScene, gpgpu.simulationCamera);

    // Pass 2: Position update
    gpgpu.simulationUniforms.positions.value  = gpgpu.positionTargets[currentPositionTarget].texture;
    gpgpu.simulationUniforms.velocities.value = gpgpu.velocityTargets[nextVelocityTarget].texture;
    gpgpu.simulationMesh.material = gpgpu.positionMaterial;
    renderer.setRenderTarget(gpgpu.positionTargets[nextPositionTarget]);
    renderer.render(gpgpu.simulationScene, gpgpu.simulationCamera);

    renderer.setRenderTarget(null);

    // Update render uniforms
    gpgpu.renderUniforms.positions.value = gpgpu.positionTargets[nextPositionTarget].texture;

    // Render particles
    renderer.render(scene, camera);

    // Swap ping-pong buffers
    currentPositionTarget = nextPositionTarget;
    currentVelocityTarget = nextVelocityTarget;

    // === Morph progression ===
    if (isMorphing) {
        gpgpu.simulationUniforms.morphProgress.value += deltaTime;

        if (gpgpu.simulationUniforms.morphProgress.value >= 3.0) {
            isMorphing = false;
            isIdle = true;

            gpgpu.simulationUniforms.isMorphing.value = false;
            gpgpu.simulationUniforms.isIdle.value = true;

            gpgpu.simulationUniforms.originalPositions.value =
                currentLogo === 'matrix'
                    ? gpgpu.matrixPositionTexture
                    : gpgpu.deltaPositionTexture;

            gpgpu.simulationUniforms.targetPositions.value = null;
            
            // Ensure color mix is complete when morphing finishes
            gpgpu.renderUniforms.colorMix.value = 1.0;
        }
    }
    
    // Ensure color mix is complete when flocking settles
    if (flockingPhase === "settled") {
        gpgpu.renderUniforms.colorMix.value = 1.0;
    }
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Start the application
Promise.all([
    loadImageData('./Matrix_CMYK_Logo.png'),
    loadImageData('./Delta_Logo.png')
]).then(([matrixData, deltaData]) => {
    initGPGPU();
    initParticles(matrixData, deltaData);
    positionCamera(); 
    animate();
}).catch(error => {
    console.error("Error loading images:", error);
});
