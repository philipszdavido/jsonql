const log = console.log.bind(console.log)

var q = {
    query: {
        args: [
            {
                first: 2
            }
        ]
        products: {
            name: String,
            email: String
        }
    }
}

log(q)