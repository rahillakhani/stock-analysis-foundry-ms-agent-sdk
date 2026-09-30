import { z } from 'zod';
import { IsoDateTime } from './common.ts';

/**
 * Opaque id a metric uses to cite where its value came from, e.g. `nse:quote:tatasteel:2026-09-30`.
 * Never a file path or a link: no `/`, no `..`. Links belong in `Source.url`.
 */
export const SourceId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/, 'must be a lowercase source id')
  .refine((id) => !id.includes('..'), 'must not contain ".."');
export type SourceId = z.infer<typeof SourceId>;

/** https link shown in the UI. No embedded credentials; adapters should also strip query-string secrets. */
const SourceUrl = z
  .url({ protocol: /^https$/, hostname: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i })
  .max(2048)
  .refine((url) => {
    const parsed = new URL(url);
    return parsed.username === '' && parsed.password === '';
  }, 'must not contain credentials');

export const Source = z.object({
  id: SourceId,
  /** Provider adapter name, e.g. `fixture`, `nse`, `screener`. */
  provider: z.string().min(1).max(64),
  url: SourceUrl.optional(),
  retrievedAt: IsoDateTime,
});
export type Source = z.infer<typeof Source>;
