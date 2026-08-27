export async function activate(volund) {
  await volund.tools.register({
    name: 'community.echo',
    description: 'sandbox E2E',
    invoke(input) {
      return { text: String(input?.text ?? '') }
    },
  })
}
