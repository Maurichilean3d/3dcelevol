import * as THREE from ‘three’;
import { OrbitControls } from ‘three/addons/controls/OrbitControls.js’;
import { setupSubcomponents } from ‘./editor-subcomponents.js’;

/* =============================
CONFIG
============================= */
const CFG = {
bg: 0xf2f2f7,
objColor: 0xdbe4eb,
objEdge: 0xffffff,
selColor: 0xFF9500,
selEdge: 0xFFB84D,

subAccent: 0x00BFFF, // blue for sub-selection highlight
minScale: 0.05,
maxScale: 10.0,
minZoom: 2,
maxZoom: 80,
maxDistance: 40,

arrowSize: 2.6
};

const IS_MOBILE =
matchMedia(’(pointer: coarse)’).matches ||
Math.min(window.innerWidth, window.innerHeight) < 700;

/* =============================
DOM
============================= */
const overlay = document.getElementById(‘overlay’);
const btnStart = document.getElementById(‘btn-start’);

const themeLight = document.getElementById(‘theme-light’);
const themeDark = document.getElementById(‘theme-dark’);

const renderBar = document.getElementById(‘render-bar’);
const cameraBar = document.getElementById(‘camera-bar’);

const btnExit = document.getElementById(‘exit-manipulation’);
const spaceToggle = document.getElementById(‘space-toggle’);
const spaceIcon = document.getElementById(‘space-icon’);
const spaceText = document.getElementById(‘space-text’);
const editValuesBtn = document.getElementById(‘edit-values-btn’);

const subtoolbar = document.getElementById(‘subtoolbar’);
const btnSubVerts = document.getElementById(‘sub-verts’);
const btnSubEdges = document.getElementById(‘sub-edges’);
const btnSubFaces = document.getElementById(‘sub-faces’);
const btnSubExplode = document.getElementById(‘sub-explode’);
const btnSubClear = document.getElementById(‘sub-clear’);

const btnUndo = document.getElementById(‘btn-undo’);
const btnRedo = document.getElementById(‘btn-redo’);

const confirmDialog = document.getElementById(‘confirm-dialog’);
const btnCancel = document.getElementById(‘btn-cancel’);
const btnOk = document.getElementById(‘btn-ok’);

const axisDialog = document.getElementById(‘axis-input-dialog’);
const axisTitle = document.getElementById(‘axis-title’);
const axisSubtitle = document.getElementById(‘axis-subtitle’);
const inputX = document.getElementById(‘input-x’);
const inputY = document.getElementById(‘input-y’);
const inputZ = document.getElementById(‘input-z’);
const btnApply = document.getElementById(‘btn-apply’);
const btnClose = document.getElementById(‘btn-close’);

const measurementLine = document.getElementById(‘measurement-line’);
const distanceLabel = document.getElementById(‘distance-label’);
const measureLine = document.getElementById(‘measure-line’);
const originDot = document.getElementById(‘origin-dot’);

const editCamPanel = document.getElementById(‘edit-cam-panel’);
const btnCamZoom = document.getElementById(‘btn-cam-zoom’);
const btnCamOrbit = document.getElementById(‘btn-cam-orbit’);

const toolbar = document.getElementById(‘toolbar’);
const btnDelete = document.getElementById(‘btn-delete’);
const btnColor = document.getElementById(‘btn-color’);

/* =============================
THREE CORE
============================= */
let scene, camera, renderer, orbit;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

const objects = [];
let nextObjectId = 1;

let gridTexture = null;
let currentRenderMode = ‘flat’;

/* =============================
STATE
============================= */
let selectedObject = null;
let currentMode = ‘translate’; // translate|rotate|scale|select
let currentSpace = ‘world’;    // world|local

let currentGizmo = null;
let activeHandle = null;

let isDragging = false;
let dragStart = new THREE.Vector2();
let touchStart = new THREE.Vector2();
let lastTapTime = 0;

let originPosition = new THREE.Vector3();

/* =============================
CAMERA LOCKS DURING EDIT
============================= */
let isEditMode = false;
let editZoomEnabled = false;
let editOrbitEnabled = false;

function setEditMode(on) {
isEditMode = on;
if (on) {
editZoomEnabled = false;
editOrbitEnabled = false;
editCamPanel.classList.add(‘visible’);
btnCamZoom.classList.toggle(‘active’, editZoomEnabled);
btnCamOrbit.classList.toggle(‘active’, editOrbitEnabled);
applyCameraLocks();
} else {
editCamPanel.classList.remove(‘visible’);
orbit.enableZoom = true;
orbit.enableRotate = true;
orbit.enablePan = true;
}
}
function applyCameraLocks() {
if (!isEditMode) return;
orbit.enableZoom = !!editZoomEnabled;
orbit.enableRotate = !!editOrbitEnabled;
orbit.enablePan = false;
}
btnCamZoom.addEventListener(‘click’, () => {
if (!isEditMode) return;
editZoomEnabled = !editZoomEnabled;
btnCamZoom.classList.toggle(‘active’, editZoomEnabled);
applyCameraLocks();
});
btnCamOrbit.addEventListener(‘click’, () => {
if (!isEditMode) return;
editOrbitEnabled = !editOrbitEnabled;
btnCamOrbit.classList.toggle(‘active’, editOrbitEnabled);
applyCameraLocks();
});

/* =============================
UNDO / REDO
============================= */
const undoStack = [];
const redoStack = [];

function updateUndoRedoUI() {
btnUndo.disabled = undoStack.length === 0;
btnRedo.disabled = redoStack.length === 0;
}
function pushAction(action) {
undoStack.push(action);
redoStack.length = 0;
updateUndoRedoUI();
}
btnUndo.addEventListener(‘click’, undo);
btnRedo.addEventListener(‘click’, redo);

function snapshotTransform(obj) {
return {
pos: obj.position.toArray(),
quat: obj.quaternion.toArray(),
scl: obj.scale.toArray()
};
}
function applySnapshot(obj, snap) {
obj.position.fromArray(snap.pos);
obj.quaternion.fromArray(snap.quat);
obj.scale.fromArray(snap.scl);
obj.rotation.setFromQuaternion(obj.quaternion);
}
function findById(id) {
return objects.find(o => o.userData?.id === id) || null;
}
function removeObjectFromScene(obj) {
scene.remove(obj);
const i = objects.indexOf(obj);
if (i >= 0) objects.splice(i, 1);
}
function performForward(a) {
if (a.type === ‘add’) {
for (const item of a.items) {
const obj = createPrimitive(item.prim.type, item.prim.id);
applySnapshot(obj, item.state);
scene.add(obj);
objects.push(obj);
applyRenderMode(obj, currentRenderMode);
}
} else if (a.type === ‘delete’) {
for (const id of a.ids) {
const obj = findById(id);
if (obj) removeObjectFromScene(obj);
}
deselectAll();
} else if (a.type === ‘transform’) {
const obj = findById(a.id);
if (obj) applySnapshot(obj, a.after);
} else if (a.type === ‘subEdit’) {
subAPI.applySubEditForward(a);
}
}
function performInverse(a) {
if (a.type === ‘add’) {
for (const item of a.items) {
const obj = findById(item.prim.id);
if (obj) removeObjectFromScene(obj);
}
deselectAll();
} else if (a.type === ‘delete’) {
for (const item of a.items) {
const obj = createPrimitive(item.prim.type, item.prim.id);
applySnapshot(obj, item.state);
scene.add(obj);
objects.push(obj);
applyRenderMode(obj, currentRenderMode);
}
} else if (a.type === ‘transform’) {
const obj = findById(a.id);
if (obj) applySnapshot(obj, a.before);
} else if (a.type === ‘subEdit’) {
subAPI.applySubEditInverse(a);
}
}
function undo() {
const a = undoStack.pop();
if (!a) return;
redoStack.push(a);
performInverse(a);
updateUndoRedoUI();
}
function redo() {
const a = redoStack.pop();
if (!a) return;
undoStack.push(a);
performForward(a);
updateUndoRedoUI();
}

/* =============================
VIEWPORT / ZOOM HELPERS
============================= */
function isWorldPointOffscreen(worldPoint, margin = 0.12) {
const v = worldPoint.clone().project(camera);
const m = margin * 2;
return (v.x < -1 + m) || (v.x > 1 - m) || (v.y < -1 + m) || (v.y > 1 - m);
}
function getCameraDir() {
const d = new THREE.Vector3();
camera.getWorldDirection(d);
return d.normalize();
}

/* =============================
DRAG PLANE (translate)
============================= */
let dragState = null;
// { plane, startHit, axisDirW|null, baseCamDist, objRadius, anchorCenterW }

function intersectPlane(screenX, screenY, plane) {
const rect = renderer.domElement.getBoundingClientRect();
mouse.x = ((screenX - rect.left) / rect.width) * 2 - 1;
mouse.y = -((screenY - rect.top) / rect.height) * 2 + 1;
raycaster.setFromCamera(mouse, camera);
const p = new THREE.Vector3();
const ok = raycaster.ray.intersectPlane(plane, p);
return ok ? p : null;
}
function axisToVec(a) {
if (a === ‘x’) return new THREE.Vector3(1, 0, 0);
if (a === ‘y’) return new THREE.Vector3(0, 1, 0);
if (a === ‘z’) return new THREE.Vector3(0, 0, 1);
return new THREE.Vector3(1, 0, 0);
}
function makeAxisDragPlane(axisDirW, anchorPointW) {
const camDir = getCameraDir();
let n = new THREE.Vector3().crossVectors(axisDirW, camDir);
if (n.lengthSq() < 1e-8) {
n = new THREE.Vector3().crossVectors(axisDirW, new THREE.Vector3(0, 1, 0));
if (n.lengthSq() < 1e-8) n = new THREE.Vector3().crossVectors(axisDirW, new THREE.Vector3(1, 0, 0));
}
const planeNormal = new THREE.Vector3().crossVectors(n, axisDirW).normalize();
return new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, anchorPointW);
}
function beginTranslateDrag(axis, anchorW, centerW, objRadius) {
let plane;
let axisDirW = null;

if (axis === ‘free’) {
plane = new THREE.Plane().setFromNormalAndCoplanarPoint(getCameraDir(), anchorW);
} else {
axisDirW = axisToVec(axis);
if (currentSpace === ‘local’ && selectedObject) axisDirW.applyQuaternion(selectedObject.quaternion).normalize();
plane = makeAxisDragPlane(axisDirW, anchorW);
}

const startHit = intersectPlane(dragStart.x, dragStart.y, plane) || anchorW.clone();

dragState = {
plane,
startHit,
axisDirW,
baseCamDist: camera.position.distanceTo(centerW),
objRadius,
anchorCenterW: centerW.clone()
};
}

/* ✅ Zoom inteligente leve SOLO si se sale del encuadre */
function updateIntelligentZoomFromMoved(movedDistance) {
if (!dragState) return;
if (!isWorldPointOffscreen(dragState.anchorCenterW, 0.10)) return;

const sizeFactor = Math.max(1, dragState.objRadius * 1.4);
const target = dragState.baseCamDist + (movedDistance * 0.85) + (movedDistance / (sizeFactor * 2.0));
const clamped = THREE.MathUtils.clamp(target, CFG.minZoom, CFG.maxZoom);

const current = camera.position.distanceTo(dragState.anchorCenterW);
const newDist = THREE.MathUtils.lerp(current, clamped, 0.10);

const dir = camera.position.clone().sub(dragState.anchorCenterW).normalize();
camera.position.copy(dragState.anchorCenterW.clone().add(dir.multiplyScalar(newDist)));
orbit.target.copy(dragState.anchorCenterW);
camera.lookAt(dragState.anchorCenterW);
orbit.update();
}

/* =============================
CAMERA PRESETS
============================= */
function fitBox(box) {
const center = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
const maxSize = Math.max(size.x, size.y, size.z);
const fov = THREE.MathUtils.degToRad(camera.fov);
const fitDist = (maxSize * 0.5) / Math.tan(fov * 0.5);
const dist = THREE.MathUtils.clamp(fitDist * 2.4, CFG.minZoom, CFG.maxZoom);
const dir = new THREE.Vector3(1, 0.85, 1).normalize();
orbit.target.copy(center);
camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
camera.lookAt(center);
orbit.update();
}
function fitAll() {
if (!objects.length) return;
const box = new THREE.Box3();
objects.forEach(o => box.expandByObject(o));
fitBox(box);
}
function focusSelected() {
if (!selectedObject) return;
const box = new THREE.Box3().setFromObject(selectedObject);
fitBox(box);
}
function snapView(name) {
const t = selectedObject
? new THREE.Box3().setFromObject(selectedObject).getCenter(new THREE.Vector3())
: orbit.target.clone();

const dist = THREE.MathUtils.clamp(camera.position.distanceTo(orbit.target), CFG.minZoom, CFG.maxZoom);
let dir = new THREE.Vector3(1, 1, 1).normalize();
if (name === ‘iso’) dir = new THREE.Vector3(1, 1, 1).normalize();
if (name === ‘top’) dir = new THREE.Vector3(0, 1, 0);
if (name === ‘front’) dir = new THREE.Vector3(0, 0, 1);
if (name === ‘right’) dir = new THREE.Vector3(1, 0, 0);

orbit.target.copy(t);
camera.position.copy(t.clone().add(dir.multiplyScalar(dist)));
camera.lookAt(t);
orbit.update();
}

/* ✅ Auto-focus al seleccionar: en móvil NO hace zoom, solo recenter si está fuera */
function focusSelectedSoft() {
if (!selectedObject) return;

const box = new THREE.Box3().setFromObject(selectedObject);
const center = box.getCenter(new THREE.Vector3());

if (!isWorldPointOffscreen(center, 0.10)) return;

orbit.target.lerp(center, 0.22);
if (IS_MOBILE) { orbit.update(); return; }

const size = box.getSize(new THREE.Vector3());
const maxSize = Math.max(size.x, size.y, size.z);
const currentDist = camera.position.distanceTo(orbit.target);
const desiredMin = Math.max(CFG.minZoom, maxSize * 1.8);
const desiredMax = Math.min(CFG.maxZoom, maxSize * 10.0);
const clampedDist = THREE.MathUtils.clamp(currentDist, desiredMin, desiredMax);
const dir = camera.position.clone().sub(orbit.target).normalize();
const newDist = THREE.MathUtils.lerp(currentDist, clampedDist, 0.12);
camera.position.copy(orbit.target.clone().add(dir.multiplyScalar(newDist)));
camera.lookAt(orbit.target);
orbit.update();
}

/* =============================
GIZMOS
============================= */
function removeGizmo() {
if (currentGizmo) {
scene.remove(currentGizmo);
currentGizmo = null;
}
}
function createTranslateGizmo() {
const gizmo = new THREE.Group();
const L = CFG.arrowSize;

const ax = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), L, 0xFF3B30, 0.6, 0.4);
ax.userData.axis = ‘x’;
const ay = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), L, 0x34C759, 0.6, 0.4);
ay.userData.axis = ‘y’;
const az = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), L, 0x007AFF, 0.6, 0.4);
az.userData.axis = ‘z’;

const center = new THREE.Mesh(
new THREE.SphereGeometry(0.3, 16, 16),
new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false })
);
center.userData.axis = ‘free’;
center.renderOrder = 999;

gizmo.add(ax, ay, az, center);
gizmo.traverse(c => {
if (c.material) {
c.material.depthTest = false;
c.material.depthWrite = false;
c.renderOrder = 999;
}
});
return gizmo;
}
function createRotateGizmo() {
const gizmo = new THREE.Group();
const r = 2.0;

const ringX = new THREE.Mesh(
new THREE.TorusGeometry(r, 0.08, 16, 64),
new THREE.MeshBasicMaterial({ color: 0xFF3B30, transparent: true, opacity: 0.85, depthTest: false })
);
ringX.rotation.y = Math.PI / 2;
ringX.userData.axis = ‘x’;

const ringY = new THREE.Mesh(
new THREE.TorusGeometry(r, 0.08, 16, 64),
new THREE.MeshBasicMaterial({ color: 0x34C759, transparent: true, opacity: 0.85, depthTest: false })
);
ringY.rotation.x = Math.PI / 2;
ringY.userData.axis = ‘y’;

const ringZ = new THREE.Mesh(
new THREE.TorusGeometry(r, 0.08, 16, 64),
new THREE.MeshBasicMaterial({ color: 0x007AFF, transparent: true, opacity: 0.85, depthTest: false })
);
ringZ.userData.axis = ‘z’;

gizmo.add(ringX, ringY, ringZ);
gizmo.traverse(c => { if (c.material) { c.material.depthTest = false; c.renderOrder = 999; }});
return gizmo;
}
function createScaleGizmo() {
const gizmo = new THREE.Group();
const len = 2.0;
const s = 0.3;

function handle(color, axis, pos) {
const h = new THREE.Mesh(
new THREE.BoxGeometry(s, s, s),
new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false })
);
h.position.copy(pos);
h.userData.axis = axis;
h.renderOrder = 999;
return h;
}
function line(color, a, b) {
return new THREE.Line(
new THREE.BufferGeometry().setFromPoints([a, b]),
new THREE.LineBasicMaterial({ color, depthTest: false })
);
}

const hx = handle(0xFF3B30, ‘x’, new THREE.Vector3(len, 0, 0));
const hy = handle(0x34C759, ‘y’, new THREE.Vector3(0, len, 0));
const hz = handle(0x007AFF, ‘z’, new THREE.Vector3(0, 0, len));
const hu = handle(0xffffff, ‘uniform’, new THREE.Vector3(0, 0, 0));

gizmo.add(
hx, line(0xFF3B30, new THREE.Vector3(0,0,0), new THREE.Vector3(len,0,0)),
hy, line(0x34C759, new THREE.Vector3(0,0,0), new THREE.Vector3(0,len,0)),
hz, line(0x007AFF, new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,len)),
hu
);

gizmo.traverse(c => { if (c.material) { c.material.depthTest = false; c.material.depthWrite = false; c.renderOrder = 999; }});
return gizmo;
}

/**

- gizmoScale: 1.0 normal, 0.5 subcomponent (requested)
  */
  function createGizmoFor(mode, position, targetObject, gizmoScale = 1.0) {
  removeGizmo();
  if (mode === ‘translate’) currentGizmo = createTranslateGizmo();
  else if (mode === ‘rotate’) currentGizmo = createRotateGizmo();
  else if (mode === ‘scale’) currentGizmo = createScaleGizmo();
  else return null;

currentGizmo.position.copy(position);

if (targetObject && currentSpace === ‘local’) currentGizmo.quaternion.copy(targetObject.quaternion);
else currentGizmo.quaternion.identity();

currentGizmo.scale.setScalar(gizmoScale);
scene.add(currentGizmo);
return currentGizmo;
}

function updateGizmoPose() {
if (!currentGizmo || !selectedObject) return;

if (currentMode === ‘select’) {
const p = subAPI.getSelectionWorldCenter();
if (p) currentGizmo.position.copy(p);
} else {
currentGizmo.position.copy(selectedObject.position);
}

if (currentSpace === ‘local’) currentGizmo.quaternion.copy(selectedObject.quaternion);
else currentGizmo.quaternion.identity();
}

/* =============================
SELECTION VISUALS
============================= */
function setObjectSelectedVisual(obj, on) {
if (!obj?.material) return;
if (on) {
obj.material.color.setHex(CFG.selColor);
if (obj.userData.edges) {
obj.userData.edges.material.color.setHex(CFG.selEdge);
obj.userData.edges.material.opacity = 0.85;
}
} else {
obj.material.color.setHex(obj.userData.originalColor ?? CFG.objColor);
if (obj.userData.edges) {
obj.userData.edges.material.color.setHex(CFG.objEdge);
obj.userData.edges.material.opacity = 0.5;
}
}
}

function applySelectionUI() {
objects.forEach(o => setObjectSelectedVisual(o, false));
if (selectedObject) setObjectSelectedVisual(selectedObject, true);

if (selectedObject) {
btnExit.classList.add(‘visible’);
spaceToggle.classList.add(‘visible’);
editValuesBtn.classList.add(‘visible’);

```
setEditMode(true);

if (currentMode === 'select') {
  subtoolbar.classList.add('visible');
  subAPI.applySubVisibility(selectedObject);
  // Create subcomponent gizmo ONLY when there is sub selection
  const center = subAPI.getSelectionWorldCenter();
  if (center) createGizmoFor('translate', center, selectedObject, 1.0);
  else removeGizmo();
} else {
  subtoolbar.classList.remove('visible');
  subAPI.clearSelection();
  createGizmoFor(currentMode, selectedObject.position, selectedObject, 1.0);
}

updateEditButtonPosition();
focusSelectedSoft();
```

} else {
btnExit.classList.remove(‘visible’);
spaceToggle.classList.remove(‘visible’);
editValuesBtn.classList.remove(‘visible’);

```
subtoolbar.classList.remove('visible');
subAPI.clearSelection();
setEditMode(false);
removeGizmo();
hideConfirm();
```

}
}

function deselectAll() {
selectedObject = null;
subAPI?.clearSelection?.();
applySelectionUI();
}

/* =============================
UI: MODE + SUBTOOLBAR
============================= */
function setMode(mode) {
currentMode = mode;
toolbar.querySelectorAll(’[data-mode]’).forEach(b => b.classList.remove(‘active’));
const btn = toolbar.querySelector(`[data-mode="${mode}"]`);
if (btn) btn.classList.add(‘active’);

if (selectedObject) {
if (currentMode === ‘select’) {
subtoolbar.classList.add(‘visible’);
subAPI.applySubVisibility(selectedObject);
const center = subAPI.getSelectionWorldCenter();
if (center) createGizmoFor(‘translate’, center, selectedObject, 1.0);
else removeGizmo();
} else {
subtoolbar.classList.remove(‘visible’);
subAPI.clearSelection();
createGizmoFor(currentMode, selectedObject.position, selectedObject, 1.0);
hideConfirm();
}
}
}

/* =============================
UI: THEME
============================= */
function setTheme(theme) {
if (theme === ‘dark’) {
document.body.classList.add(‘dark-mode’);
themeLight.classList.remove(‘active’);
themeDark.classList.add(‘active’);
scene.background = new THREE.Color(0x1c1c1e);
scene.fog = new THREE.Fog(0x1c1c1e, 10, 220);
} else {
document.body.classList.remove(‘dark-mode’);
themeLight.classList.add(‘active’);
themeDark.classList.remove(‘active’);
scene.background = new THREE.Color(CFG.bg);
scene.fog = new THREE.Fog(CFG.bg, 10, 220);
}
}

/* =============================
MEASUREMENT
============================= */
function showMeasure() {
measurementLine.classList.add(‘visible’);
distanceLabel.classList.add(‘visible’);
}
function hideMeasure() {
measurementLine.classList.remove(‘visible’);
distanceLabel.classList.remove(‘visible’);
}
function toScreenPosition(position) {
const v = position.clone().project(camera);
return {
x: (v.x * 0.5 + 0.5) * window.innerWidth,
y: (-(v.y * 0.5) + 0.5) * window.innerHeight
};
}
function updateMeasureLine(worldPos) {
if (!measurementLine.classList.contains(‘visible’)) return;

const a = toScreenPosition(originPosition);
const b = toScreenPosition(worldPos);

measureLine.setAttribute(‘x1’, a.x);
measureLine.setAttribute(‘y1’, a.y);
measureLine.setAttribute(‘x2’, b.x);
measureLine.setAttribute(‘y2’, b.y);

originDot.setAttribute(‘cx’, a.x);
originDot.setAttribute(‘cy’, a.y);

distanceLabel.textContent = `${worldPos.distanceTo(originPosition).toFixed(2)} m`;
distanceLabel.style.left = ((a.x + b.x) / 2) + ‘px’;
distanceLabel.style.top = (((a.y + b.y) / 2) - 30) + ‘px’;
}

/* =============================
AXIS DIALOG
============================= */
function openAxisDialog() {
if (!selectedObject) return;

const titles = {
translate: [‘Posición Exacta’, ‘Ingresa X, Y, Z’],
rotate: [‘Rotación Exacta’, ‘Grados (°)’],
scale: [‘Escala Exacta’, ‘Factores X, Y, Z’],
select: [‘Selección’, ‘Edita subcomponentes con el gizmo’]
};
const [t, s] = titles[currentMode] ?? titles.translate;
axisTitle.textContent = t;
axisSubtitle.textContent = s;

if (currentMode === ‘translate’) {
inputX.value = selectedObject.position.x.toFixed(2);
inputY.value = selectedObject.position.y.toFixed(2);
inputZ.value = selectedObject.position.z.toFixed(2);
} else if (currentMode === ‘rotate’) {
inputX.value = (selectedObject.rotation.x * 180 / Math.PI).toFixed(1);
inputY.value = (selectedObject.rotation.y * 180 / Math.PI).toFixed(1);
inputZ.value = (selectedObject.rotation.z * 180 / Math.PI).toFixed(1);
} else if (currentMode === ‘scale’) {
inputX.value = selectedObject.scale.x.toFixed(2);
inputY.value = selectedObject.scale.y.toFixed(2);
inputZ.value = selectedObject.scale.z.toFixed(2);
} else {
inputX.value = selectedObject.position.x.toFixed(2);
inputY.value = selectedObject.position.y.toFixed(2);
inputZ.value = selectedObject.position.z.toFixed(2);
}

axisDialog.classList.add(‘visible’);
}
function closeAxisDialog() {
axisDialog.classList.remove(‘visible’);
}
function clampScale(v) {
return Math.max(CFG.minScale, Math.min(CFG.maxScale, v));
}
btnApply.addEventListener(‘click’, () => {
if (!selectedObject) return;
const before = snapshotTransform(selectedObject);

const x = parseFloat(inputX.value);
const y = parseFloat(inputY.value);
const z = parseFloat(inputZ.value);
if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

if (currentMode === ‘translate’) {
selectedObject.position.set(x, y, z);
} else if (currentMode === ‘rotate’) {
selectedObject.rotation.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180);
selectedObject.quaternion.setFromEuler(selectedObject.rotation);
} else if (currentMode === ‘scale’) {
selectedObject.scale.set(clampScale(x), clampScale(y), clampScale(z));
} else {
selectedObject.position.set(x, y, z);
}

enforceLimits(selectedObject);
updateGizmoPose();

const after = snapshotTransform(selectedObject);
pushAction({ type: ‘transform’, id: selectedObject.userData.id, before, after });
closeAxisDialog();
});
btnClose.addEventListener(‘click’, closeAxisDialog);

/* =============================
CONFIRM MINI
============================= */
function showConfirm() { confirmDialog.classList.add(‘visible’); }
function hideConfirm() { confirmDialog.classList.remove(‘visible’); }

btnCancel.addEventListener(‘click’, () => {
// Cancel sub edits: revert to baseline if any, keep selection mode available
subAPI.cancelToBaseline();
const center = subAPI.getSelectionWorldCenter();
if (currentMode === ‘select’ && selectedObject) {
if (center) createGizmoFor(‘translate’, center, selectedObject, 1.0);
else removeGizmo();
}
hideMeasure();
});

btnOk.addEventListener(‘click’, () => {
// Commit sub edit if any
const action = subAPI.commitSelectionDeltaAsAction(selectedObject?.userData?.id);
if (action) pushAction(action);
subAPI.setBaselineFromCurrent(); // new baseline after commit
hideMeasure();
});

/* =============================
OBJECT CREATION
============================= */
function createTechTexture() {
const c = document.createElement(‘canvas’);
c.width = 512; c.height = 512;
const ctx = c.getContext(‘2d’);
ctx.fillStyle = ‘#f0f0f5’;
ctx.fillRect(0, 0, 512, 512);
ctx.strokeStyle = ‘#d1d1d6’;
ctx.lineWidth = 2;
ctx.beginPath();
for (let i = 0; i <= 512; i += 64) {
ctx.moveTo(i, 0); ctx.lineTo(i, 512);
ctx.moveTo(0, i); ctx.lineTo(512, i);
}
ctx.stroke();
const t = new THREE.CanvasTexture(c);
t.wrapS = t.wrapT = THREE.RepeatWrapping;
return t;
}

function createPrimitive(type, id) {
let geo;
if (type === ‘box’) geo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
else if (type === ‘sphere’) geo = new THREE.SphereGeometry(0.9, 48, 48);
else if (type === ‘cylinder’) geo = new THREE.CylinderGeometry(0.8, 0.8, 1.8, 48);
else if (type === ‘cone’) geo = new THREE.ConeGeometry(0.9, 2.0, 48);
else if (type === ‘torus’) geo = new THREE.TorusGeometry(1.0, 0.28, 24, 80);
else if (type === ‘plane’) geo = new THREE.PlaneGeometry(3.5, 3.5, 1, 1);
else geo = new THREE.BoxGeometry(1.5, 1.5, 1.5);

const mat = new THREE.MeshStandardMaterial({
color: CFG.objColor, roughness: 0.45, metalness: 0.08,
side: THREE.DoubleSide
});

const mesh = new THREE.Mesh(geo, mat);
mesh.castShadow = true;
mesh.receiveShadow = true;

mesh.userData.id = id;
mesh.userData.primType = type; // ✅ important for undo delete
mesh.userData.originalColor = CFG.objColor;

const edges = new THREE.LineSegments(
new THREE.EdgesGeometry(geo),
new THREE.LineBasicMaterial({ color: CFG.objEdge, transparent: true, opacity: 0.5 })
);
mesh.add(edges);
mesh.userData.edges = edges;

if (type === ‘plane’) {
mesh.rotation.x = -Math.PI / 2;
mesh.quaternion.setFromEuler(mesh.rotation);
mesh.position.y = 0.02;
}
return mesh;
}

function spawn(type) {
const id = nextObjectId++;
const mesh = createPrimitive(type, id);

mesh.position.set((Math.random() - 0.5) * 2, 0.75, (Math.random() - 0.5) * 2);

scene.add(mesh);
objects.push(mesh);
applyRenderMode(mesh, currentRenderMode);

pushAction({
type: ‘add’,
items: [{ prim: { type, id }, state: snapshotTransform(mesh) }]
});
}

/* =============================
RENDER MODE
============================= */
function applyRenderMode(mesh, mode) {
const m = mesh.material;
const e = mesh.userData.edges;

if (mode === ‘flat’) {
m.map = null;
m.roughness = 0.45;
if (mesh !== selectedObject) m.color.setHex(mesh.userData.originalColor ?? CFG.objColor);
if (e) e.visible = true;
} else if (mode === ‘clay’) {
m.map = null;
m.roughness = 1.0;
if (mesh !== selectedObject) m.color.setHex(0xd0d0d5);
if (e) e.visible = false;
} else if (mode === ‘tech’) {
m.map = gridTexture;
m.roughness = 0.55;
if (mesh !== selectedObject) m.color.setHex(0xffffff);
if (e) e.visible = true;
}
m.needsUpdate = true;
}

/* =============================
DELETE / COLOR
============================= */
btnDelete.addEventListener(‘click’, () => {
if (!selectedObject) return;

const ids = [selectedObject.userData.id];
const items = [{
prim: { type: selectedObject.userData.primType ?? ‘box’, id: selectedObject.userData.id },
state: snapshotTransform(selectedObject)
}];

pushAction({ type: ‘delete’, ids, items });

const toRemove = selectedObject;
deselectAll();
removeObjectFromScene(toRemove);
});

btnColor.addEventListener(‘click’, () => {
if (!selectedObject) return;
const c = Math.random() * 0xffffff;
selectedObject.material.color.setHex(c);
selectedObject.userData.originalColor = c;
applySelectionUI();
});

/* =============================
LIMITS
============================= */
function enforceLimits(obj) {
if (!obj) return;
if (obj.position.length() > CFG.maxDistance) obj.position.setLength(CFG.maxDistance);
if (obj.position.y < 0) obj.position.y = 0;

obj.scale.x = clampScale(obj.scale.x);
obj.scale.y = clampScale(obj.scale.y);
obj.scale.z = clampScale(obj.scale.z);
}

/* =============================
HANDLE PICKING
============================= */
function getIntersectedHandle(x, y) {
if (!currentGizmo) return null;

const rect = renderer.domElement.getBoundingClientRect();
mouse.x = ((x - rect.left) / rect.width) * 2 - 1;
mouse.y = -((y - rect.top) / rect.height) * 2 + 1;

raycaster.setFromCamera(mouse, camera);

const handles = [];
currentGizmo.traverse(child => { if (child.isMesh || child.isLine) handles.push(child); });
const hits = raycaster.intersectObjects(handles, true);
if (!hits.length) return null;

let o = hits[0].object;
while (o.parent && o.parent !== currentGizmo) o = o.parent;
return o;
}

/* =============================
TRANSFORM / SUB-DRAG
============================= */
function rotateWorld(obj, worldAxis, angle) {
const q = new THREE.Quaternion().setFromAxisAngle(worldAxis, angle);
obj.quaternion.premultiply(q);
obj.rotation.setFromQuaternion(obj.quaternion);
}

function saveOriginState() {
if (!selectedObject) return;
const center = (currentMode === ‘select’)
? (subAPI.getSelectionWorldCenter() ?? selectedObject.position.clone())
: selectedObject.position.clone();
originPosition.copy(center);
}

function manipulateByGizmo(x, y) {
if (!activeHandle || !selectedObject) return;
const axis = activeHandle.userData.axis;

// subcomponent translate (select mode)
if (currentMode === ‘select’ && subAPI.hasSelection()) {
if (!dragState) return;
const hit = intersectPlane(x, y, dragState.plane);
if (!hit) return;

```
let worldDelta = hit.clone().sub(dragState.startHit);
if (dragState.axisDirW) {
  const s = worldDelta.dot(dragState.axisDirW);
  worldDelta = dragState.axisDirW.clone().multiplyScalar(s);
}

const movedDistance = subAPI.applySelectionWorldDelta(selectedObject, worldDelta);
updateGizmoPose();

const c = subAPI.getSelectionWorldCenter();
if (c) updateMeasureLine(c);

updateIntelligentZoomFromMoved(movedDistance);

dragState.startHit.copy(hit);
dragStart.set(x, y);
return;
```

}

// object transforms
if (currentMode === ‘translate’) {
if (!dragState) return;
const hit = intersectPlane(x, y, dragState.plane);
if (!hit) return;

```
let worldDelta = hit.clone().sub(dragState.startHit);
if (dragState.axisDirW) {
  const s = worldDelta.dot(dragState.axisDirW);
  worldDelta = dragState.axisDirW.clone().multiplyScalar(s);
}

selectedObject.position.add(worldDelta);
enforceLimits(selectedObject);

updateMeasureLine(selectedObject.position);
updateIntelligentZoomFromMoved(selectedObject.position.distanceTo(originPosition));

updateGizmoPose();
dragState.startHit.copy(hit);
dragStart.set(x, y);
```

} else if (currentMode === ‘rotate’) {
const rotScale = 0.02;
const delta = (x - dragStart.x + y - dragStart.y) * rotScale;
if (axis === ‘x’ || axis === ‘y’ || axis === ‘z’) {
const ax = axisToVec(axis);
if (currentSpace === ‘local’) selectedObject.rotateOnAxis(ax, delta);
else rotateWorld(selectedObject, ax, delta);
}
updateGizmoPose();
dragStart.set(x, y);

} else if (currentMode === ‘scale’) {
const scaleSpeed = 0.01;
const delta = (dragStart.y - y) * scaleSpeed; // ✅ up grows
if (axis === ‘x’) selectedObject.scale.x = clampScale(selectedObject.scale.x + delta);
else if (axis === ‘y’) selectedObject.scale.y = clampScale(selectedObject.scale.y + delta);
else if (axis === ‘z’) selectedObject.scale.z = clampScale(selectedObject.scale.z + delta);
else if (axis === ‘uniform’) {
const s = clampScale(selectedObject.scale.x + delta);
selectedObject.scale.set(s, s, s);
}
updateGizmoPose();
dragStart.set(x, y);
}
}

/* =============================
DOUBLE TAP SELECTION
============================= */
function handleDoubleTap(x, y) {
const rect = renderer.domElement.getBoundingClientRect();
mouse.x = ((x - rect.left) / rect.width) * 2 - 1;
mouse.y = -((y - rect.top) / rect.height) * 2 + 1;
raycaster.setFromCamera(mouse, camera);

// In select mode: pick subcomponent and toggle in selection (dynamic)
if (currentMode === ‘select’ && selectedObject) {
const changed = subAPI.togglePick(raycaster, selectedObject);
if (changed) {
const center = subAPI.getSelectionWorldCenter();
if (center) {
createGizmoFor(‘translate’, center, selectedObject, 1.0); // ✅ same scale as object gizmo
showConfirm(); // keep visible while selecting more
} else {
removeGizmo();
hideConfirm();
}
return;
}
}

// Object pick
const hits = raycaster.intersectObjects(objects, false);
if (hits.length) {
const hit = hits[0].object;
selectedObject = hit;
subAPI.clearSelection();
applySelectionUI();
} else {
deselectAll();
}
}

/* =============================
POINTER EVENTS
============================= */
function setupPointerEvents() {
const canvas = renderer.domElement;

canvas.addEventListener(‘pointerdown’, (e) => {
touchStart.set(e.clientX, e.clientY);
dragStart.set(e.clientX, e.clientY);

```
if (selectedObject && currentGizmo) {
  const h = getIntersectedHandle(e.clientX, e.clientY);
  if (h) {
    activeHandle = h;
    isDragging = true;

    // freeze camera while dragging gizmo
    orbit.enableZoom = false;
    orbit.enableRotate = false;
    orbit.enablePan = false;

    // snapshot BEFORE for undo transforms
    if (currentMode !== 'select') selectedObject.userData._dragBefore = snapshotTransform(selectedObject);

    saveOriginState();

    // begin translate plane if needed
    const axis = activeHandle.userData.axis;

    const box = new THREE.Box3().setFromObject(selectedObject);
    const centerW = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.55;

    const anchorW = (currentMode === 'select')
      ? (subAPI.getSelectionWorldCenter() ?? currentGizmo.position.clone())
      : currentGizmo.position.clone();

    if (currentMode === 'translate' || (currentMode === 'select' && subAPI.hasSelection())) {
      beginTranslateDrag(axis, anchorW, centerW, radius);
      showMeasure();
      originPosition.copy(anchorW);
      updateMeasureLine(anchorW);
    } else {
      dragState = null;
    }

    return;
  }
}
```

});

canvas.addEventListener(‘pointermove’, (e) => {
if (isDragging && activeHandle) {
manipulateByGizmo(e.clientX, e.clientY);
}
});

canvas.addEventListener(‘pointerup’, (e) => {
const dist = Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y);

```
if (isDragging) {
  isDragging = false;
  activeHandle = null;
  dragState = null;
  hideMeasure();

  // restore locks
  if (isEditMode) applyCameraLocks();
  else { orbit.enableZoom = true; orbit.enableRotate = true; orbit.enablePan = true; }

  // push transform action if object mode
  if (selectedObject && currentMode !== 'select') {
    const before = selectedObject.userData._dragBefore;
    if (before) {
      const after = snapshotTransform(selectedObject);
      const changed =
        before.pos.some((v, i) => Math.abs(v - after.pos[i]) > 1e-6) ||
        before.quat.some((v, i) => Math.abs(v - after.quat[i]) > 1e-6) ||
        before.scl.some((v, i) => Math.abs(v - after.scl[i]) > 1e-6);

      if (changed) pushAction({ type: 'transform', id: selectedObject.userData.id, before, after });
      delete selectedObject.userData._dragBefore;
    }
  }

  // In select mode, keep confirm visible (don’t force close)
  if (currentMode === 'select' && subAPI.hasSelection()) showConfirm();
  return;
}

if (dist < 15) {
  const now = Date.now();
  if (now - lastTapTime < 400) {
    handleDoubleTap(e.clientX, e.clientY);
    lastTapTime = 0;
  } else {
    lastTapTime = now;
  }
}
```

});
}

/* =============================
EDIT BUTTON POSITION
============================= */
function updateEditButtonPosition() {
if (!selectedObject || !editValuesBtn.classList.contains(‘visible’)) return;
const p = selectedObject.position.clone();
p.x += 3.5; p.y += 1.0;
const s = toScreenPosition(p);
editValuesBtn.style.left = s.x + ‘px’;
editValuesBtn.style.top = s.y + ‘px’;
editValuesBtn.style.transform = ‘translate(-50%,-50%)’;
}

/* =============================
SUBTOOLBAR HOOKS
============================= */
function setSubButtonActive(btn, on) {
btn.classList.toggle(‘active’, !!on);
}
function refreshSubButtonsFromState() {
setSubButtonActive(btnSubVerts, subAPI.getFlags().verts);
setSubButtonActive(btnSubEdges, subAPI.getFlags().edges);
setSubButtonActive(btnSubFaces, subAPI.getFlags().faces);
setSubButtonActive(btnSubExplode, subAPI.getFlags().explode);
}

btnSubVerts.addEventListener(‘click’, () => {
subAPI.setFlags({ verts: !subAPI.getFlags().verts });
refreshSubButtonsFromState();
if (selectedObject) subAPI.applySubVisibility(selectedObject);
});
btnSubEdges.addEventListener(‘click’, () => {
subAPI.setFlags({ edges: !subAPI.getFlags().edges });
refreshSubButtonsFromState();
if (selectedObject) subAPI.applySubVisibility(selectedObject);
});
btnSubFaces.addEventListener(‘click’, () => {
subAPI.setFlags({ faces: !subAPI.getFlags().faces });
refreshSubButtonsFromState();
if (selectedObject) subAPI.applySubVisibility(selectedObject);
});
btnSubExplode.addEventListener(‘click’, () => {
// explode affects vertex grouping behavior (requested)
subAPI.setFlags({ explode: !subAPI.getFlags().explode });
refreshSubButtonsFromState();
});
btnSubClear.addEventListener(‘click’, () => {
subAPI.clearSelection();
if (selectedObject) subAPI.applySubVisibility(selectedObject);
removeGizmo();
hideConfirm();
});

/* =============================
INIT
============================= */
let subAPI = null;

function init() {
scene = new THREE.Scene();
scene.background = new THREE.Color(CFG.bg);
scene.fog = new THREE.Fog(CFG.bg, 10, 220);

camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(5, 6, 8);

renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0xffffff, 0.8));
const dir = new THREE.DirectionalLight(0xffffff, 1.5);
dir.position.set(5, 15, 10);
dir.castShadow = true;
dir.shadow.mapSize.set(2048, 2048);
dir.shadow.camera.left = -60;
dir.shadow.camera.right = 60;
dir.shadow.camera.top = 60;
dir.shadow.camera.bottom = -60;
scene.add(dir);

scene.add(new THREE.GridHelper(160, 160, 0xc7c7cc, 0xe5e5ea));
const axes = new THREE.AxesHelper(2.8);
axes.material.depthTest = false;
axes.renderOrder = 1;
scene.add(axes);

gridTexture = createTechTexture();

orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.05;
orbit.maxPolarAngle = Math.PI / 2 - 0.05;
orbit.minDistance = CFG.minZoom;
orbit.maxDistance = CFG.maxZoom;

subAPI = setupSubcomponents({
THREE,
CFG,
scene,
camera,
renderer,
findObjectById: (id) => findById(id)
});

// default sub flags: vertices ON, merge ON (explode OFF)
subAPI.setFlags({ verts: true, edges: false, faces: false, explode: false });
refreshSubButtonsFromState();

setupPointerEvents();

window.addEventListener(‘resize’, () => {
camera.aspect = window.innerWidth / window.innerHeight;
camera.updateProjectionMatrix();
renderer.setSize(window.innerWidth, window.innerHeight);
});

themeLight.addEventListener(‘click’, () => setTheme(‘light’));
themeDark.addEventListener(‘click’, () => setTheme(‘dark’));

btnStart.addEventListener(‘click’, () => {
overlay.style.opacity = 0;
setTimeout(() => overlay.style.display = ‘none’, 450);
spawn(‘box’);
});

renderBar.querySelectorAll(’[data-render]’).forEach(btn => {
btn.addEventListener(‘click’, () => {
renderBar.querySelectorAll(’[data-render]’).forEach(b => b.classList.remove(‘active’));
btn.classList.add(‘active’);
const mode = btn.dataset.render;
currentRenderMode = (mode === ‘flat’) ? ‘flat’ : (mode === ‘clay’) ? ‘clay’ : ‘tech’;
objects.forEach(o => applyRenderMode(o, currentRenderMode));
});
});

cameraBar.querySelectorAll(’[data-cam]’).forEach(btn => {
btn.addEventListener(‘click’, () => {
const c = btn.dataset.cam;
if (c === ‘fitall’) fitAll();
else if (c === ‘focus’) focusSelected();
else snapView(c);
});
});

toolbar.querySelectorAll(’[data-spawn]’).forEach(btn => {
btn.addEventListener(‘click’, () => spawn(btn.dataset.spawn));
});
toolbar.querySelectorAll(’[data-mode]’).forEach(btn => {
btn.addEventListener(‘click’, () => setMode(btn.dataset.mode));
});

btnExit.addEventListener(‘click’, () => deselectAll());

spaceToggle.addEventListener(‘click’, () => {
currentSpace = (currentSpace === ‘world’) ? ‘local’ : ‘world’;
spaceToggle.classList.toggle(‘local’, currentSpace === ‘local’);
spaceIcon.textContent = (currentSpace === ‘local’) ? ‘📍’ : ‘🌍’;
spaceText.textContent = (currentSpace === ‘local’) ? ‘Local’ : ‘Global’;

```
if (selectedObject) {
  if (currentMode === 'select') {
    const center = subAPI.getSelectionWorldCenter();
    if (center) createGizmoFor('translate', center, selectedObject, 1.0);
  } else {
    createGizmoFor(currentMode, selectedObject.position, selectedObject, 1.0);
  }
}
```

});

editValuesBtn.addEventListener(‘click’, (e) => {
e.stopPropagation();
openAxisDialog();
});

updateUndoRedoUI();
}

function animate() {
requestAnimationFrame(animate);
if (selectedObject && editValuesBtn.classList.contains(‘visible’)) updateEditButtonPosition();
orbit.update();
renderer.render(scene, camera);
}

init();
animate();

/* =============================
EXPOSE DEBUG (optional)
============================= */
window._mr = { get scene(){return scene;}, get camera(){return camera;}, get objects(){return objects;} };
