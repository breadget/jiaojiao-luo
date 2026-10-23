package animalabstract;

/** 继承抽象类 Animal 的狗类，必须重写全部抽象方法 */
public class Dog extends Animal {
    @Override
    public void cry() {
        System.out.println("汪汪汪！");
    }

    @Override
    public String getAnimalName() {
        return "狗";
    }
}
