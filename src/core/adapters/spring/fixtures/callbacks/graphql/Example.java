package app;
import com.netflix.graphql.dgs.DgsData;
import com.netflix.graphql.dgs.DgsComponent;
@DgsComponent class Me {
  @DgsData Object first() { return null; }
  @DgsData Object second() { return null; }
}
@DgsData class WrongType {}
@DgsComponent abstract class Abstract {
  @DgsData abstract Object missing();
}
@DgsData @interface Composed {}
@DgsComponent class ComposedUse {
  @Composed Object composed() { return null; }
}
class Unregistered {
  @DgsData Object missing() { return null; }
}
@DgsComponent class Lookalike {
  @other.DgsData Object ignored() { return null; }
}
