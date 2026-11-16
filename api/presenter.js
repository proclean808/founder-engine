import { handlePresenter } from "../dist/src/presenter-web.js";
import { respond } from "./_respond.js";
export const config = { maxDuration: 60 };
export default (req, res) => respond(req, res, ["POST"], handlePresenter);
