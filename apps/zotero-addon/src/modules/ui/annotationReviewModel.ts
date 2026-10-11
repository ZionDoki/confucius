import type { AnnotationReviewEntry } from "@confucius/protocol";
import { ReviewModel } from "./reviewModel";
export {
  reviewEntryKey,
  type ReviewFilter,
  type ReviewScopeView,
} from "./reviewModel";
export type ReviewRow =
  import("./reviewModel").ReviewRow<AnnotationReviewEntry>;
export class AnnotationReviewModel extends ReviewModel<AnnotationReviewEntry> {}
