// maps-realestate: type-only shim of LINA's src/data/properties.ts.
// Vendored src/geo imports FeedLandmark from '../data/properties'; keeping the
// same path here means src/geo stays BYTE-IDENTICAL between this repo and the
// bot (the sync contract: LINA rsyncs src/geo FROM maps-realestate master).

export interface FeedLandmark {
  landmark: string;
  type?: string;
  distance_m?: number;
  maps_url?: string;
}
