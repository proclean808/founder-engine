import { handleVetRepos } from "../dist/src/web.js";
import { respond } from "./_respond.js";
export const config = { maxDuration: 60 };
export default (req, res) => respond(req, res, ["POST"], handleVetRepos);
