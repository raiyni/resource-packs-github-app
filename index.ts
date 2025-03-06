// Deployments API example
// See: https://developer.github.com/v3/repos/deployments/ to learn more

import { Probot, ProbotOctokit } from 'probot'
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods'
import unzipjs from './unzipjs'
import 'dotenv/config'

type Octokit = InstanceType<typeof ProbotOctokit>
type Tag = RestEndpointMethodTypes['repos']['listTags']['response']['data'][0]

const owner = process.env.OWNER
const repo = process.env.REPO

const CHANGELOG_WEBHOOK = process.env.CHANGELOG_WEBHOOK
const WEBHOOK_USER = process.env.WEBHOOK_USER
const WEBHOOK_AVATAR = process.env.WEBHOOK_AVATAR

const MASTER = 'master'
const EMPTY_PACK = 'pack-empty'

const MARKER = '<!-- rpphc -->'

const PACK_MERGED = 'Pack: merged'
const PACK_APPROVED = 'Pack: approved'
const PACK_UPDATE = 'Pack: updated'
const NEW_PACK = 'Pack: new'

const PASSES_CHECKS = 'Checks: passed'
const HAS_ERRORS = 'Checks: failed'

const addLabels = async (github: Octokit, number: number, labels: string[]) => {
	return github.issues.addLabels({
		owner,
		repo,
		issue_number: number,
		labels
	})
}

const removeLabels = async (github: Octokit, number: number, name: string, labels: Set<string>) => {
	if (labels.has(name)) {
		return github.issues.removeLabel({
			owner,
			repo,
			issue_number: number,
			name
		})
	}

	return Promise.resolve()
}

const createComment = async (github: Octokit, number: number, message: string) => {
	const body = MARKER + '\n' + message
	const issue = { owner, repo, issue_number: number }

	const sticky = (await github.issues.listComments(issue)).data.find((c) => c.body?.startsWith(MARKER))

	if (sticky) {
		await github.issues.updateComment({ ...issue, comment_id: sticky.id, body })
	} else if (message) {
		await github.issues.createComment({ ...issue, body })
	}
}

const parseErrors = (logs: string) => {
	const regex = /\[ERRORS\]\n([\s\S]*?)\[\/ERRORS\]/
	const match = logs.match(regex)
	if (match) {
		// Filter out timestamps and trim whitespace
		return match[1]
			.split('\n')
			.map((line: string) =>
				line
					.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, '')
					.replace(/[^\x00-\x7F]/g, '')
					.replace(/\x1B\[31m/g, '')
					.replace(/\x1B\[0m/g, '')
					.trim()
			)
			.filter((line: string | any[]) => line.length > 0)
			.map((line: string) => '- ' + line)
			.join('\n')
	}
	return null
}

const checkBranch = async (github: Octokit, number: number, branchName: string) => {
	const regex = /^[a-zA-Z0-9._\-/]+$/
	if (!regex.test(branchName)) {
		createComment(github, number, `**Branch \`${branchName}\` contains invalid characters**`)
		return false
	}

	try {
		const branch = await github.repos.getBranch({
			owner,
			repo,
			branch: branchName
		})

		if (branch.status == 200) {
			createComment(github, number, `**Branch \`${branchName}\` exists already**`)
			return false
		}
	} catch (e) {
		// Branch does not exist
		return true
	}
}

const getTags = async (github: Octokit, owner: string, repo: string): Promise<Tag[]> => {
	const tags = await github.paginate(github.repos.listTags, {
		owner,
		repo,
		per_page: 100 // Adjust the number of tags per page if needed
	})

	// Sort tags by their creation date (assuming semantic versioning)
	tags.sort((a, b) => {
		return b.name.localeCompare(a.name, undefined, { numeric: true })
	})

	return tags
}

const getPreviousTag = function (octokit: Octokit, owner: string, repo: string, tags: Tag[], newTag: string) {
	try {
		// Find the index of the new tag
		const newTagIndex = tags.findIndex((tag) => tag.name === newTag)

		if (newTagIndex === -1) {
			throw new Error(`Tag ${newTag} not found in the repository.`)
		}

		// Get the previous tag
		const previousTag = tags[newTagIndex + 1]?.name

		if (!previousTag) {
			throw new Error(`No previous tag found for ${newTag}.`)
		}

		return previousTag
	} catch (error) {
		console.error('Error fetching previous tag:', error)
		throw error
	}
}

const updateOrCreateRelease = async (octokit: Octokit, owner: string, repo: string, tag: string, name: string, body: string) => {
	try {
		// Check if the release already exists
		let release: RestEndpointMethodTypes['repos']['getReleaseByTag']['response']['data']
		try {
			const response = await octokit.rest.repos.getReleaseByTag({
				owner,
				repo,
				tag
			})
			release = response.data
		} catch (error) {
			console.log(error)
			if (error.status === 404) {
				// Release does not exist, create a new one
				const res = await octokit.rest.repos.createRelease({
					owner,
					repo,
					tag_name: tag,
					name,
					body
				})
				console.log(`New release created: ${res.data.html_url}`)

				return res.data
			} else {
				throw error // Re-throw other errors
			}
		}

		// If the release exists, update it
		if (release) {
			const res = await octokit.rest.repos.updateRelease({
				owner,
				repo,
				release_id: release.id,
				tag_name: tag,
				name,
				body
			})
			console.log(`Release updated: ${res.data.html_url}`)
			return res.data
		}
	} catch (error) {
		console.error('Error updating or creating release:', error)
		throw error
	}
}

const sendDiscordWebhook = async (url: string, body: string) => {
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			username: WEBHOOK_USER,
			avatar_url: WEBHOOK_AVATAR,

			content: body,

			allowed_mentions: {
				parse: ['roles', 'users', 'everyone']
			}
		})
	})

	return res
}

export = (app: Probot) => {
	app.on('push', async (context) => {
		const github = context.octokit
		const ref = context.payload.ref
		const refs = ref.split('/')

		const tag = refs[2]
		const refType = refs[1]

		if (refType == 'tags' && tag.startsWith('v')) {
			const newTag = tag

			const tags = await getTags(github, owner, repo)
			const previousTag = getPreviousTag(github, owner, repo, tags, newTag)

			const commits = await github.repos.compareCommits({
				owner,
				repo,
				head: newTag,
				base: previousTag
			})

			const changelog = commits.data.commits
				.map((commit) => {
					return `- [${commit.sha.substring(0, 8)}](https://github.com/${owner}/${repo}/commit/${commit.sha}) - ${commit.commit.message.split('\n')[0]}`
				})
				.reverse()
				.join('\n')

			let webhookLog = commits.data.commits
				.map((commit) => {
					return `- ${commit.commit.message.split('\n')[0]}`
				})
				.reverse()
				.join('\n')
			if (webhookLog.length > 1900) {
				webhookLog = webhookLog.substring(0, 1900) + '...'
			}

			const release = await updateOrCreateRelease(github, owner, repo, newTag, `Sample/Resource packs  ${newTag}`, `## Changelog\n\n${changelog}`)

			const message = `# New release: [${newTag}](${release.html_url})
[direct download](${release.zipball_url})
## Changelog

\`\`\`${webhookLog}\`\`\`

<@&1347304836110225418>`

			const webhook = await sendDiscordWebhook(CHANGELOG_WEBHOOK, message)
			if (webhook.status != 200) {
				console.error(`Failed to send webhook: ${webhook.status} ${webhook.statusText}`)
				const text = await webhook.text()
				console.error(text)
			}
		}
	})

	app.on(['pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened'], async (context) => {
		const github = context.octokit
		const workflow_id = 'check-pack.yml'
		const ref = MASTER

		const base = context.payload.pull_request.base
		const head = context.payload.pull_request.head
		const number = context.payload.pull_request.number

		let { data: labelList } = await github.issues.listLabelsOnIssue(context.issue())
		let labels = new Set(labelList.map((l) => l.name))

		if (base.ref == EMPTY_PACK) {
			github.issues.addLabels({
				owner,
				repo,
				issue_number: number,
				labels: [NEW_PACK]
			})

			if (!checkBranch(github, number, head.ref)) {
				removeLabels(github, number, PACK_APPROVED, labels)
				return
			}
		} else if (base.ref.startsWith('pack-')) {
			github.issues.addLabels({
				owner,
				repo,
				issue_number: number,
				labels: [PACK_UPDATE]
			})
		}

		removeLabels(github, number, PASSES_CHECKS, labels)
		createComment(github, number, '**Checking pack...**')
		github.rest.actions.createWorkflowDispatch({
			owner,
			repo,
			workflow_id,
			ref,
			inputs: {
				pr: number + '',
				sha: context.payload.pull_request.head.sha,
				ref: context.payload.pull_request.head.ref
			}
		})
	})

	app.on(['pull_request.labeled'], async (context) => {
		const github = context.octokit

		let { data: labelList } = await github.issues.listLabelsOnIssue(context.issue())
		let labels = new Set(labelList.map((l) => l.name))

		const label = context.payload.label.name
		const number = context.payload.pull_request.number
		const pull_request = context.payload.pull_request

		if (label == PACK_APPROVED) {
			const newPack = labels.has(NEW_PACK)
			const ref = pull_request.head.ref
			if (newPack) {
				if (!checkBranch(github, number, ref)) {
					removeLabels(github, number, PACK_APPROVED, labels)
					return
				}

				const res = await github.git.createRef({
					owner,
					repo,
					ref: `refs/heads/${ref}`,
					sha: pull_request.head.sha
				})

				if (res.status == 201) {
					createComment(github, number, `**Branch \`${ref}\` created successfully**`)
					github.rest.issues.update({
						owner,
						repo,
						issue_number: number,
						state: 'closed'
					})
					addLabels(github, number, [PACK_MERGED])
				} else {
					createComment(github, number, `**Failed to create branch \`${ref}\`**`)
					removeLabels(github, number, PACK_APPROVED, labels)
				}
			} else {
				if (!pull_request.mergeable || pull_request.mergeable_state != 'clean') {
					createComment(github, number, `**Pack unable to be merged**`)
					removeLabels(github, number, PACK_APPROVED, labels)
					return
				}

				const res = await github.rest.pulls.merge({
					owner,
					repo,
					pull_number: number,
					merge_method: 'merge'
				})

				if (res.status == 200) {
					createComment(github, number, `**Pack approved and merged successfully**`)
					addLabels(github, number, [PACK_MERGED])
				} else {
					createComment(github, number, `**Failed to merge pack**`)
					removeLabels(github, number, PACK_APPROVED, labels)
				}
			}
		}
	})

	app.on(['workflow_run.completed'], async (context) => {
		const github = context.octokit
		if (context.payload.repository.full_name != `${owner}/${repo}` || context.payload.workflow_run.path != '.github/workflows/check-pack.yml') {
			return
		}

		const workflow_run = context.payload.workflow_run
		const issue_number = +workflow_run.name.split('-')[0]

		let { data: labelList } = await github.issues.listLabelsOnIssue({ owner, repo, issue_number })
		let labels = new Set(labelList.map((l) => l.name))

		if (workflow_run.conclusion == 'success') {
			removeLabels(github, issue_number, HAS_ERRORS, labels)
			addLabels(github, issue_number, [PASSES_CHECKS])
			createComment(github, issue_number, 'Pack checks passed... Waiting for approval')
			return
		}

		const logsUrl = `GET /repos/${owner}/${repo}/actions/runs/${workflow_run.id}/logs`
		const res = await github.request(`${logsUrl}`)

		let unzipped = unzipjs.parse(res.data)
		for (let item of unzipped) {
			if (item.name.includes('Read errors')) {
				const logs = item.toString()
				const errors = parseErrors(logs)

				if (errors) {
					const message = `**Errors found in pack**\n\n${errors}\n`
					createComment(github, issue_number, message)
					addLabels(github, issue_number, [HAS_ERRORS])
					return
				}
			}
		}
	})
}
