import { createHyExp0028Handler } from '../src/model/hy-exp-0028-entry.mjs';

export default async function handler(request, response) {
  return createHyExp0028Handler()(request, response);
}
