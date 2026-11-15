import { handleExtract } from "../dist/src/web.js";
import { respond } from "./_respond.js";
export default (req, res) => respond(req, res, ["POST"], handleExtract);
