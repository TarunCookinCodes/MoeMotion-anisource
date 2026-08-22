import { handler } from "../functions/api.js"

export default async function (req, res) {
  return handler(req, res)
}
