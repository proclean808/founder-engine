import { handleHealth } from "../dist/src/web.js";
import { respond } from "./_respond.js";
export default (req, res) => respond(req, res, ["GET"], handleHealth);
