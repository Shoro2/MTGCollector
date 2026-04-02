import { initDb } from '$lib/server/db';
import { checkAndUpdatePrices } from '$lib/server/price-updater';

// Initialize database tables on server start
initDb();

// Check if prices need updating (runs in background, non-blocking)
checkAndUpdatePrices();
