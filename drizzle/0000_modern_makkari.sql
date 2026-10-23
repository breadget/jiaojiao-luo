CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_name` text NOT NULL,
	`workflow_version` integer NOT NULL,
	`status` text NOT NULL,
	`steps_json` text NOT NULL,
	`logs_json` text NOT NULL,
	`output_json` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_runs_workflow_started_at` ON `runs` (`workflow_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`draft_steps_json` text NOT NULL,
	`published_steps_json` text,
	`version` integer DEFAULT 0 NOT NULL,
	`has_unpublished_changes` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`published_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_workflows_updated_at` ON `workflows` (`updated_at`);