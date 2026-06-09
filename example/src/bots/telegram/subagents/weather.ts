import { defineSubagent } from "@elumixor/nitro-bot";

// File name → subagent name ("weather"). Tools tagged `subagent: "weather"` (see routes/weather.get.ts)
// route here: the coordinator delegates instead of seeing get_weather directly.
export default defineSubagent({
  description: "Weather lookups — current temperature for a city.",
  systemPrompt: "You answer weather questions. Look up the city and report the temperature plainly.",
});
