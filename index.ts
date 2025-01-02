// Deployments API example
// See: https://developer.github.com/v3/repos/deployments/ to learn more

import { Probot, ProbotOctokit } from "probot";
import { OctokitResponse, GetResponseTypeFromEndpointMethod } from "@octokit/types";
type Octokit = InstanceType<typeof ProbotOctokit>;
type PullsListFilesResponseData = GetResponseTypeFromEndpointMethod<Octokit["pulls"]["listFiles"]>["data"]

const MARKER = '<!-- rpphc -->'

export = (app: Probot) => {
	app.on(['pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened'], async context => {
    const github = context.octokit;
    let difftext = Math.random() + '';

    let marker = "<!-- rlphc -->";
		let body = marker + "\n" + difftext;

		let sticky = (await github.issues.listComments(context.issue()))
			.data.find(c => c.body?.startsWith(marker));

		if (sticky) {
			await github.issues.updateComment(context.issue({ comment_id: sticky.id, body }));
		} else if (difftext) {
			await github.issues.createComment(context.issue({ body }));
		}
	})
}
