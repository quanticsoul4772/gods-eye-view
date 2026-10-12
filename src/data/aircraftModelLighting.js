/**
 * Lighting options shared by every aircraft 3D model (Flights, Military
 * Flights, Local ADS-B).
 *
 * Cesium gives each Model a dynamic environment map: it renders the sky around
 * the model and reads the result back from the GPU (`readPixels`) to light it,
 * and redoes that whenever the model moves more than 1 km. An airliner covers
 * that in four seconds, so a tracked aircraft's model spent ~2.1 s of every
 * 10 s of main-thread time on GPU readbacks (Intel Arc, Chrome, D3D11). The
 * models are tinted near-flat by code (`colorBlendAmount`), so the dynamic sky
 * lighting is barely visible on them; they use Cesium's default lighting.
 */
export const AIRCRAFT_ENVIRONMENT_MAP_OPTIONS = Object.freeze({
  enabled: false,
});
