/**
 * editor-core.js (Fragmentos clave actualizados)
 */

// ... (Resto del código de inicialización igual)

function updateGizmoPose() {
  if (!currentGizmo || !selectedObject) return;

  if (currentMode === 'select') {
    const center = subAPI.getSelectionWorldCenter();
    if (center) {
      currentGizmo.position.copy(center);
      currentGizmo.quaternion.copy(selectedObject.quaternion);
      currentGizmo.visible = true;
    } else {
      currentGizmo.visible = false;
    }
  } else {
    currentGizmo.position.copy(selectedObject.position);
    currentGizmo.visible = true;
    if (currentSpace === 'local') currentGizmo.quaternion.copy(selectedObject.quaternion);
    else currentGizmo.quaternion.identity();
  }
}

function handleDoubleTap(x, y) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((x - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((y - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  if (currentMode === 'select' && selectedObject) {
    const changed = subAPI.togglePick(raycaster, selectedObject);
    if (changed) {
      const center = subAPI.getSelectionWorldCenter();
      if (center) {
        // Creamos el Gizmo específicamente en la posición de los vértices
        createGizmoFor('translate', center, selectedObject, 0.5); 
        showConfirm(); 
      }
      updateGizmoPose();
      return;
    }
  }

  const hits = raycaster.intersectObjects(objects, false);
  if (hits.length > 0) {
    selectedObject = hits[0].object;
    applySelectionUI();
  } else {
    deselectAll();
  }
}

// Dentro de animate() o del loop de render:
// Asegúrate de llamar a updateGizmoPose() si hay una manipulación activa.
