import { handlePitch } from "../dist/src/web.js";
import { respond } from "./_respond.js";
export const config = { maxDuration: 30 };
export default (req, res) => respond(req, res, ["POST"], handlePitch);
